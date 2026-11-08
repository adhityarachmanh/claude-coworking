// 🧩 src/role-usage.js: the per-role split is a proportion from the transcripts, applied to the real ledger total.
// Synthetic transcripts make the expected percentages exact; the payload must never contain prompt text.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const TMP = mkdtempSync(path.join(tmpdir(), 'office-role-usage-'));
process.env.CLAUDE_PROJECTS_DIR = path.join(TMP, 'claude');

after(() => rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

const projectPath = path.join(TMP, 'project');
const projectKey = path.resolve(projectPath).replace(/[^a-zA-Z0-9]/g, '-');
const transcriptDir = path.join(TMP, 'claude', projectKey);
const sessionId = '11111111-1111-4111-8111-111111111111';

const usage = (input, output) => ({ input_tokens: input, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
const assistant = (input, output, text = 'isi percakapan yang tidak boleh bocor') =>
  JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { usage: usage(input, output), content: [{ type: 'text', text }] } });

function writeSession({ session = sessionId, main = true, agents = [] } = {}) {
  mkdirSync(transcriptDir, { recursive: true });
  if (main) writeFileSync(path.join(transcriptDir, `${session}.jsonl`), `${assistant(60, 40)}\n`);
  const sub = path.join(transcriptDir, session, 'subagents');
  mkdirSync(sub, { recursive: true });
  for (const [i, agent] of agents.entries()) {
    const file = path.join(sub, `agent-${i}.jsonl`);
    writeFileSync(file, `${assistant(agent.input, agent.output, agent.text ?? 'rahasia subagent')}\n`);
    writeFileSync(file.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ agentType: agent.type }));
  }
}

const hub = { projects: new Map([['p1', { id: 'p1', path: projectPath }]]) };
const row = { projectId: 'p1', sessionId, input: 600, output: 200, cacheRead: 200, cacheWrite: 0, costUsd: 2 };

test('roleUsage: splits the ledger by transcript proportions, Lead gets the main thread', async () => {
  writeSession({ agents: [{ type: 'backend', input: 200, output: 100 }, { type: 'qa', input: 60, output: 40 }] });
  const { roleUsage } = await import('../src/role-usage.js');
  const result = roleUsage([row], { hub, from: 0, to: Date.now() + 1000 });
  assert.equal(result.totalTokens, 1000);
  assert.equal(result.estimated, true);
  const byRole = Object.fromEntries(result.roles.map((r) => [r.role, r]));
  assert.equal(byRole.backend.tokens, 600);
  assert.equal(byRole.qa.tokens, 200);
  assert.equal(byRole.claude.tokens, 200);
  assert.equal(Math.round(byRole.backend.share * 100), 60);
  assert.equal(byRole.backend.delegations, 1);
  assert.equal(byRole.qa.delegations, 1);
  assert.equal(byRole.claude.delegations, 0);
  assert.equal(byRole.backend.costUsd, 1.2);
  assert.equal(byRole.qa.costUsd, 0.4);
  assert.equal(byRole.claude.costUsd, 0.4);
  assert.equal(result.roles.reduce((n, r) => n + r.tokens, 0), 1000, 'the table adds up to the ledger total');
  assert.equal(result.coverage.percent, 1, 'all tokens have a transcript');
  assert.equal(result.coverage.sessionsWithTranscript, 1);
  assert.doesNotMatch(JSON.stringify(result), /bocor|rahasia|percakapan/, 'no prompt or answer text is returned');
});

test('roleUsage: a session without a transcript is "no detail", never silently the Lead', async () => {
  const { roleUsage } = await import('../src/role-usage.js');
  const missing = roleUsage([{ ...row, sessionId: '22222222-2222-4222-8222-222222222222' }], { hub, from: 0, to: Date.now() + 1000 });
  assert.equal(missing.roles.length, 1);
  assert.equal(missing.roles[0].role, 'unknown');
  assert.equal(missing.roles[0].label, 'Tanpa rincian role');
  assert.equal(missing.roles[0].tokens, 1000);
  assert.equal(missing.coverage.percent, 0);
  assert.equal(missing.coverage.sessionsWithTranscript, 0);

  const noProject = roleUsage([{ ...row, projectId: 'other', sessionId }], { hub, from: 0, to: Date.now() + 1000 });
  assert.equal(noProject.roles[0].role, 'unknown');
  assert.equal(noProject.roles[0].tokens, 1000);
});

test('roleUsage: OpenCode sessions without a transcript get their own honest row', async () => {
  const { roleUsage } = await import('../src/role-usage.js');
  const result = roleUsage([{ ...row, engine: 'opencode', sessionId: '44444444-4444-4444-8444-444444444444' }], {
    hub,
    from: 0,
    to: Date.now() + 1000,
  });
  assert.equal(result.roles.length, 1);
  assert.equal(result.roles[0].role, 'opencode-unknown');
  assert.equal(result.roles[0].label, 'OpenCode (tanpa rincian role)');
  assert.equal(result.coverage.percent, 0);
  assert.equal(result.coverage.unknownTokens, 1000);
});

test('roleUsage: an unknown agent type is the freelancer, never silently a specialist', async () => {
  const session = '33333333-3333-4333-8333-333333333333';
  writeSession({ session, agents: [{ type: 'agent-tanpa-peta', input: 100, output: 0 }] });
  const { roleUsage } = await import('../src/role-usage.js');
  const result = roleUsage([{ ...row, sessionId: session }], { hub, from: 0, to: Date.now() + 1000 });
  assert.equal(result.roles.some((r) => r.role === 'freelancer'), true, 'unknown type falls back to freelancer');
  assert.equal(result.roles.reduce((n, r) => n + r.tokens, 0), 1000);
});

test('roleUsage: an empty ledger is an empty table', async () => {
  const { roleUsage } = await import('../src/role-usage.js');
  const result = roleUsage([], { hub, from: 0, to: Date.now() });
  assert.deepEqual(result.roles, []);
  assert.equal(result.totalTokens, 0);
});
