; 📦 Inno Setup script for Adhitron (Windows, per-user, no admin).
; Build: node scripts/build-windows.mjs   (runs ISCC when installed)
; Output: dist/installer/Adhitron-Setup-<version>.exe
#ifndef MyAppVersion
  #define MyAppVersion "0.1.0"
#endif
#define MyAppName "Adhitron"
#define MyAppPublisher "Adhit"
#define MyAppExeName "Adhitron.exe"
#define MyDesktopExeName "AdhitronDesktop.exe"
#define BuildDir "..\dist\Adhitron"
#define DesktopDir "..\dist\electron\win-unpacked"

[Setup]
; AppId MUST stay the same across the Adhit Office → Adhitron rename: an installed 1.0.9 is upgraded in place
; (and its old uninstall entry is reused) instead of being installed twice.
; DefaultDirName below is for fresh installs; on an upgrade Inno keeps the previous folder (UsePreviousAppDir
; default), so 1.0.9 stays in Programs\AdhitOffice and its files are replaced there instead of being orphaned.
AppId={{6E1B7A3C-9D42-4F5A-9C1E-2B7D6F0A8C11}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\Programs\Adhitron
DefaultGroupName={#MyAppName}
UsePreviousGroup=no
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\dist\installer
OutputBaseFilename=Adhitron-Setup-{#MyAppVersion}
SetupIconFile=..\assets\icon.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=no
; Data lives in %LOCALAPPDATA%\AdhitOffice\data (not in {app}), so uninstall keeps it — and the folder name
; stays "AdhitOffice" on purpose: renaming it would orphan the existing history.
MinVersion=10.0

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
; One exclusive group: Website / Desktop / All. `checkedonce` defaults to All on a fresh install; upgrades keep
; whatever the user picked before (the updater runs silently without /TASKS).
Name: "modewebsite"; Description: "Website (browser/PWA)"; GroupDescription: "Mode aplikasi:"; Flags: exclusive
Name: "modedesktop"; Description: "Desktop (jendela Electron)"; GroupDescription: "Mode aplikasi:"; Flags: exclusive
Name: "modeall"; Description: "Keduanya (All)"; GroupDescription: "Mode aplikasi:"; Flags: exclusive checkedonce
Name: "autostart"; Description: "Jalankan Adhitron saat login Windows"; GroupDescription: "Startup:"; Flags: unchecked
; 🖥️ Mode "server hidup sebelum login Windows": the app itself does the work (--autologon-enable in
; src/autologon.js: AutoAdminLogon in the registry + the `Adhitron Lock` task that locks the screen 15 s after
; logon). Off by default and honest about the cost: the Windows password IS stored in the registry. A silent
; install/update (the updater) never sees this task (no tasks page) and the [Run] entry below is skipifsilent, so it
; can never ask for a password or pop a UAC prompt. NB: Inno's [Tasks] section has no skipifsilent flag (ISCC rejects
; it), which is why that flag only appears on the run entry.
Name: "bootmode"; Description: "Nyalakan server sebelum login Windows (sandi Windows disimpan di registry; layar terkunci otomatis 15 detik setelah logon)"; GroupDescription: "Startup:"; Flags: unchecked
; 🧱 Firewall Tailscale: users of the packaged app never run setup.cmd, so without this Windows blocks the
; phone's HTTPS :4318 (README troubleshooting used to make this a manual step). Checked by default; UNCHECKING
; leaves the firewall completely untouched. One UAC prompt on install; akses HP tetap harus dinyalakan di app (📱).
Name: "firewalltailscale"; Description: "Izinkan akses HP lewat Tailscale (butuh Administrator; akses HP tetap dinyalakan di app 📱)"; GroupDescription: "Akses HP:"; Flags: checkedonce

[Files]
Source: "{#BuildDir}\*"; DestDir: "{app}"; Excludes: "data\*,portable,server.log"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "{#DesktopDir}\*"; DestDir: "{app}\Desktop"; Tasks: modedesktop or modeall; Flags: recursesubdirs createallsubdirs ignoreversion

[InstallDelete]
; Transition (1.0.10 only): an in-place upgrade keeps the old files and shortcuts, which would leave a second
; autostart entry racing for port 4317. Remove the 1.0.9 binaries, shortcuts and Start Menu group first.
Type: files; Name: "{app}\AdhitOffice.exe"
Type: files; Name: "{app}\Desktop\AdhitOfficeDesktop.exe"
Type: files; Name: "{autodesktop}\Adhit Office*.lnk"
Type: files; Name: "{userstartup}\Adhit Office*.lnk"
Type: filesandordirs; Name: "{userprograms}\Adhit Office"

[Icons]
Name: "{group}\{#MyAppName} (Website)"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Tasks: modewebsite or modeall
Name: "{group}\{#MyAppName} Desktop"; Filename: "{app}\Desktop\{#MyDesktopExeName}"; WorkingDir: "{app}"; Tasks: modedesktop or modeall
Name: "{group}\Cara pakai"; Filename: "{app}\CARA-PAKAI.txt"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Tasks: modewebsite or modeall
Name: "{autodesktop}\{#MyAppName} Desktop"; Filename: "{app}\Desktop\{#MyDesktopExeName}"; WorkingDir: "{app}"; Tasks: modedesktop or modeall
; One Startup shortcut only: "bootmode" also needs it (Windows logs in by itself, then this starts the server), so the
; task adds the shortcut too instead of a second, competing entry.
Name: "{userstartup}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Parameters: "--background"; WorkingDir: "{app}"; Tasks: autostart or bootmode

[Run]
; Finished page (interactive install).
Filename: "{app}\{#MyAppExeName}"; Parameters: "--background"; Description: "Jalankan server sekarang (buka http://127.0.0.1:4317)"; Flags: postinstall nowait skipifsilent; Tasks: modewebsite or modeall
Filename: "{app}\Desktop\{#MyDesktopExeName}"; Description: "Buka Adhitron Desktop sekarang"; Flags: postinstall nowait skipifsilent; Tasks: modedesktop or modeall
Filename: "http://127.0.0.1:4317"; Description: "Buka kantor di browser"; Flags: postinstall shellexec nowait skipifsilent unchecked; Tasks: modewebsite or modeall
; Silent update/install: no finished page, so start the selected mode explicitly.
Filename: "{app}\{#MyAppExeName}"; Parameters: "--background"; Flags: nowait runhidden; Check: WizardSilent; Tasks: modewebsite or modeall
Filename: "{app}\Desktop\{#MyDesktopExeName}"; Flags: nowait runhidden; Check: WizardSilent; Tasks: modedesktop or modeall
; 🧱 The firewall fix (task "firewalltailscale", checked by default, SKIPPED on silent runs: a background
; updater must never pop a UAC prompt; unchecking the task leaves the firewall untouched). ONE elevated
; PowerShell (one UAC prompt) runs the FIXED command built by src/firewall-check.js (single source of truth —
; test/firewall-check.test.mjs keeps this exact string byte-for-byte in sync): it adds the NEW rule
; "Adhitron (Tailscale)" (TCP 4317+4318, Tailscale range 100.64.0.0/10 only, Private profile) and deletes ONLY
; the legacy rule "Claude Coworking (Tailscale)" (exact name, nothing broader). The inner netsh commands travel
; as fixed base64 (-EncodedCommand): no quoting can break across the Inno → PowerShell → Start-Process layers.
; The rule stays after uninstall (removing it would pop another UAC prompt); it only opens 4317+4318 to Tailscale.
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -Command Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-EncodedCommand','bgBlAHQAcwBoACAAYQBkAHYAZgBpAHIAZQB3AGEAbABsACAAZgBpAHIAZQB3AGEAbABsACAAYQBkAGQAIAByAHUAbABlACAAbgBhAG0AZQA9ACIAQQBkAGgAaQB0AHIAbwBuACAAKABUAGEAaQBsAHMAYwBhAGwAZQApACIAIABkAGkAcgA9AGkAbgAgAGEAYwB0AGkAbwBuAD0AYQBsAGwAbwB3ACAAcAByAG8AdABvAGMAbwBsAD0AVABDAFAAIABsAG8AYwBhAGwAcABvAHIAdAA9ADQAMwAxADcALAA0ADMAMQA4ACAAcgBlAG0AbwB0AGUAaQBwAD0AMQAwADAALgA2ADQALgAwAC4AMAAvADEAMAAgAHAAcgBvAGYAaQBsAGUAPQBwAHIAaQB2AGEAdABlADsAIABuAGUAdABzAGgAIABhAGQAdgBmAGkAcgBlAHcAYQBsAGwAIABmAGkAcgBlAHcAYQBsAGwAIABkAGUAbABlAHQAZQAgAHIAdQBsAGUAIABuAGEAbQBlAD0AIgBDAGwAYQB1AGQAZQAgAEMAbwB3AG8AcgBrAGkAbgBnACAAKABUAGEAaQBsAHMAYwBhAGwAZQApACIA'"; Description: "Pasang aturan firewall untuk akses HP lewat Tailscale (butuh izin Administrator)"; Flags: runhidden skipifsilent; Tasks: firewalltailscale
; 🖥️ Boot mode (task "bootmode", unchecked by default, SKIPPED on silent installs). This runs
; {app}\Adhitron.exe --autologon-enable as the ORDINARY user: src/autologon.js asks for Administrator itself, so
; there is exactly ONE UAC prompt and this line must never add Start-Process -Verb RunAs. The Windows password is
; never in this script, in a command line, or in the Setup log: [Code] writes it to a per-user temp file
; (adhitron-autologon-<hex>.txt, the only name the helper accepts) and deletes it again in DeinitializeSetup.
; Inno's [Run] ignores exit codes, so a hidden PowerShell wrapper runs the exe and maps the helper's exit codes
; (3 sandi salah, 4 registry, 5 bukan admin, 6 dibatalkan) to an Indonesian message box: a failure must leave the
; installation finished with autologon simply off. waituntilterminated: the hand-over has to finish before the
; wizard closes, because the temp file must not outlive it. Doubled braces below are Inno escapes for { and }.
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -Command $c=0; try {{ & '{app}\{#MyAppExeName}' '--autologon-enable' '--password-file' '{code:GetBootModePasswordFile}' '--user' '{code:GetBootModeUser}' '--domain' '{code:GetBootModeDomain}'; $c=$LASTEXITCODE }} catch {{ $c=1 }}; if ($c -ne 0) {{ $i=[Math]::Max(0,[Math]::Min(6,$c)); $m=('Autologon tidak dinyalakan: kesalahan tak terduga. Nyalakan dari Setelan Adhitron setelah instalasi.','Autologon tidak dinyalakan: kesalahan tak terduga. Nyalakan dari Setelan Adhitron setelah instalasi.','Autologon tidak dinyalakan: kesalahan tak terduga. Nyalakan dari Setelan Adhitron setelah instalasi.','Sandi Windows salah, jadi autologon TIDAK dinyalakan. Setelah instalasi, nyalakan lagi dari Setelan Adhitron.','Registry Windows tidak bisa diubah, jadi autologon TIDAK dinyalakan. Setelah instalasi, coba dari Setelan Adhitron.','Izin Administrator tidak diberikan, jadi autologon TIDAK dinyalakan. Setelah instalasi, coba dari Setelan Adhitron.','Permintaan izin dibatalkan, jadi autologon TIDAK dinyalakan. Setelah instalasi, coba dari Setelan Adhitron.')[$i]; Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show($m,'Adhitron') | Out-Null }}"; Flags: runhidden waituntilterminated skipifsilent; Check: BootModeShouldRun

[UninstallRun]
; New RunOnceIds on purpose: reusing the 1.0.9 ids ("StopAdhitDesktop"/"StopAdhitOffice") would make Inno treat the
; entries as already executed and skip killing Adhitron.exe on a later uninstall.
Filename: "{sys}\taskkill.exe"; Parameters: "/IM {#MyDesktopExeName} /F"; Flags: runhidden; RunOnceId: "StopAdhitronDesktop"
Filename: "{sys}\taskkill.exe"; Parameters: "/IM {#MyAppExeName} /F"; Flags: runhidden; RunOnceId: "StopAdhitronServer"
; Transition (1.0.10 only): the 1.0.9 install runs AdhitOffice.exe / AdhitOfficeDesktop.exe and both would keep
; port 4317 busy. taskkill exits non-zero when the process is absent; that is harmless here.
Filename: "{sys}\taskkill.exe"; Parameters: "/IM AdhitOfficeDesktop.exe /F"; Flags: runhidden; RunOnceId: "StopLegacyAdhitDesktop"
Filename: "{sys}\taskkill.exe"; Parameters: "/IM AdhitOffice.exe /F"; Flags: runhidden; RunOnceId: "StopLegacyAdhitOffice"

[Code]
// A running server/desktop keeps the .exe locked: ask Inno to close both before replacing files.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/IM {#MyDesktopExeName} /F', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/IM {#MyAppExeName} /F', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  // Legacy names from a 1.0.9 install: without this the old server holds 127.0.0.1:4317 and the new one cannot bind.
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/IM AdhitOfficeDesktop.exe /F', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/IM AdhitOffice.exe /F', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := '';
end;

// ---- 🖥️ Mode "server hidup sebelum login Windows" (task bootmode) ----
// The feature belongs to the app (Adhitron.exe --autologon-enable, src/autologon.js): Setup only collects the
// Windows password, hands it over in a per-user temp file (adhitron-autologon-<hex>.txt directly in %TEMP%, UTF-8
// without BOM and without a trailing newline — the only shape the helper accepts), and deletes that file again.
// Nothing of the password reaches this script, the registry (Setup never writes it), or the Setup log, and the
// page is skipped on silent runs, where the task is not even offered.
var
  BootModePage: TInputQueryWizardPage;
  BootModePasswordFile: String;

function BootModeSelected: Boolean;
begin
  Result := (not WizardSilent) and WizardIsTaskSelected('bootmode');
end;

procedure DeleteBootModePassword;
begin
  if BootModePasswordFile <> '' then
  begin
    DeleteFile(BootModePasswordFile);
    BootModePasswordFile := '';
  end;
end;

function WriteBootModePassword: Boolean;
var
  Dir: String;
begin
  Result := False;
  DeleteBootModePassword;  // leftovers from an earlier attempt, so no second file can survive
  Dir := GetEnv('TEMP');
  if Dir = '' then
  begin
    MsgBox('Folder sementara Windows tidak ditemukan, jadi mode sebelum login tidak dinyalakan sekarang. Setelah instalasi, nyalakan dari Setelan Adhitron.', mbError, MB_OK);
    Exit;
  end;
  // Digits only is still a valid SECRET_PATTERN name ([0-9a-f]); the millisecond timestamp makes it unique.
  // #0,#0 = no date/time separator: the helper only accepts ^adhitron-autologon-[0-9a-f]+\.txt$, so a '-' or ':'
  // leaking into the name would be refused (exit 1) after the UAC prompt.
  BootModePasswordFile := AddBackslash(Dir) + 'adhitron-autologon-' + GetDateTimeString('yyyymmddhhnnsszzz', #0, #0) + '.txt';
  // SaveStringToFile writes the raw bytes: Utf8Encode gives UTF-8 without BOM, and there is no line break, exactly
  // what src/autologon.js reads back (utf8, whole file).
  if not SaveStringToFile(BootModePasswordFile, Utf8Encode(BootModePage.Edits[0].Text), False) then
  begin
    BootModePasswordFile := '';
    MsgBox('Sandi tidak bisa disimpan sementara, jadi mode sebelum login tidak dinyalakan. Setelah instalasi, coba dari Setelan Adhitron.', mbError, MB_OK);
    Exit;
  end;
  // Out of the form as soon as it is in the file: the field is not needed again.
  BootModePage.Edits[0].Text := '';
  Result := True;
end;

function GetBootModePasswordFile(Param: String): String;
begin
  Result := BootModePasswordFile;
end;

// The account that is logged in NOW: src/autologon.js rejects any other one (S1), because these values end up in
// DefaultUserName/DefaultDomainName. GetEnv at run time: Inno's {%NAME%} constant is validated at compile time and
// rejects %USERNAME%/%USERDOMAIN% ("Invalid environment constant").
function GetBootModeUser(Param: String): String;
begin
  Result := ExpandConstant('{username}');
end;

function GetBootModeDomain(Param: String): String;
begin
  Result := GetEnv('USERDOMAIN');
end;

function BootModeShouldRun: Boolean;
begin
  Result := BootModeSelected and (BootModePasswordFile <> '');
end;

procedure InitializeWizard;
begin
  BootModePage := CreateInputQueryPage(wpSelectTasks,
    'Sandi Windows untuk mode sebelum login',
    'Server menyala sendiri setelah komputer dinyalakan, sebelum Anda login',
    'Adhitron memakai sandi akun Windows yang sedang login untuk menyalakan server otomatis, lalu mengunci layar 15 detik setelah logon. Sandi itu disimpan Windows di registry (AutoAdminLogon). Lewati halaman ini dengan menghapus centang opsinya bila tidak ingin.');
  BootModePage.Add('Sandi Windows untuk ' + ExpandConstant('{username}') + ':', False);
  // TInputQueryWizardPage.Edits is a TPasswordEdit: the Pascal Script class exposes the '*' mask only as Password
  // (the char property itself is not exposed). Password := True is what puts '*' in the field.
  BootModePage.Edits[0].Password := True;
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;
  if BootModePage <> nil then
    if PageID = BootModePage.ID then
      Result := not BootModeSelected;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if (BootModePage <> nil) and (CurPageID = BootModePage.ID) then
  begin
    if BootModePage.Edits[0].Text = '' then
    begin
      MsgBox('Sandi Windows wajib diisi untuk mode sebelum login. Hapus centang opsinya pada langkah sebelumnya bila tidak ingin memakainya.', mbError, MB_OK);
      Result := False;
      Exit;
    end;
    Result := WriteBootModePassword;
  end;
end;

procedure DeinitializeSetup();
begin
  // Every path out of the wizard (success, failure, cancel, silent) ends here: the password file never survives.
  DeleteBootModePassword;
end;
