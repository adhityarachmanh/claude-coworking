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
Name: "{userstartup}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Parameters: "--background"; WorkingDir: "{app}"; Tasks: autostart

[Run]
; Finished page (interactive install).
Filename: "{app}\{#MyAppExeName}"; Parameters: "--background"; Description: "Jalankan server sekarang (buka http://127.0.0.1:4317)"; Flags: postinstall nowait skipifsilent; Tasks: modewebsite or modeall
Filename: "{app}\Desktop\{#MyDesktopExeName}"; Description: "Buka Adhitron Desktop sekarang"; Flags: postinstall nowait skipifsilent; Tasks: modedesktop or modeall
Filename: "http://127.0.0.1:4317"; Description: "Buka kantor di browser"; Flags: postinstall shellexec nowait skipifsilent unchecked; Tasks: modewebsite or modeall
; Silent update/install: no finished page, so start the selected mode explicitly.
Filename: "{app}\{#MyAppExeName}"; Parameters: "--background"; Flags: nowait runhidden; Check: WizardSilent; Tasks: modewebsite or modeall
Filename: "{app}\Desktop\{#MyDesktopExeName}"; Flags: nowait runhidden; Check: WizardSilent; Tasks: modedesktop or modeall

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
