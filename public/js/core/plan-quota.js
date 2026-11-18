// 📊 The OpenCode Go/Console quota is shown ONLY when OpenCode Console really answered. A local estimate is not a
// subscription: users who stopped subscribing get an empty (not nagging) account panel — nothing in the app depends on
// a plan. Pure so the rule can be unit-tested without a browser.
export const goQuotaFromConsole = (go) => Boolean(go && typeof go === 'object' && go.source === 'console' && go.console && typeof go.console === 'object');
