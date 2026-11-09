; 📦 Inno Setup script for Adhit Office (Windows, per-user, no admin).
; Build: node scripts/build-windows.mjs   (runs ISCC when installed)
; Output: dist/installer/AdhitOffice-Setup-<version>.exe
#ifndef MyAppVersion
  #define MyAppVersion "0.1.0"
#endif
#define MyAppName "Adhit Office"
#define MyAppPublisher "Adhit"
#define MyAppExeName "AdhitOffice.exe"
#define MyDesktopExeName "AdhitOfficeDesktop.exe"
#define BuildDir "..\dist\AdhitOffice"
#define DesktopDir "..\dist\electron\win-unpacked"

[Setup]
AppId={{6E1B7A3C-9D42-4F5A-9C1E-2B7D6F0A8C11}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\Programs\AdhitOffice
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\dist\installer
OutputBaseFilename=AdhitOffice-Setup-{#MyAppVersion}
SetupIconFile=..\assets\icon.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=no
; Data lives in %LOCALAPPDATA%\AdhitOffice\data (not in {app}), so uninstall keeps it.
MinVersion=10.0

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
; One exclusive group: Website / Desktop / All. `checkedonce` defaults to All on a fresh install; upgrades keep
; whatever the user picked before (the updater runs silently without /TASKS).
Name: "modewebsite"; Description: "Website (browser/PWA)"; GroupDescription: "Mode aplikasi:"; Flags: exclusive
Name: "modedesktop"; Description: "Desktop (jendela Electron)"; GroupDescription: "Mode aplikasi:"; Flags: exclusive
Name: "modeall"; Description: "Keduanya (All)"; GroupDescription: "Mode aplikasi:"; Flags: exclusive checkedonce
Name: "autostart"; Description: "Jalankan Adhit Office saat login Windows"; GroupDescription: "Startup:"; Flags: unchecked

[Files]
Source: "{#BuildDir}\*"; DestDir: "{app}"; Excludes: "data\*,portable,server.log"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "{#DesktopDir}\*"; DestDir: "{app}\Desktop"; Tasks: modedesktop or modeall; Flags: recursesubdirs createallsubdirs ignoreversion

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
Filename: "{app}\Desktop\{#MyDesktopExeName}"; Description: "Buka Adhit Office Desktop sekarang"; Flags: postinstall nowait skipifsilent; Tasks: modedesktop or modeall
Filename: "http://127.0.0.1:4317"; Description: "Buka kantor di browser"; Flags: postinstall shellexec nowait skipifsilent unchecked; Tasks: modewebsite or modeall
; Silent update/install: no finished page, so start the selected mode explicitly.
Filename: "{app}\{#MyAppExeName}"; Parameters: "--background"; Flags: nowait runhidden; Check: WizardSilent; Tasks: modewebsite or modeall
Filename: "{app}\Desktop\{#MyDesktopExeName}"; Flags: nowait runhidden; Check: WizardSilent; Tasks: modedesktop or modeall

[UninstallRun]
Filename: "{sys}\taskkill.exe"; Parameters: "/IM {#MyDesktopExeName} /F"; Flags: runhidden; RunOnceId: "StopAdhitDesktop"
Filename: "{sys}\taskkill.exe"; Parameters: "/IM {#MyAppExeName} /F"; Flags: runhidden; RunOnceId: "StopAdhitOffice"

[Code]
// A running server/desktop keeps the .exe locked: ask Inno to close both before replacing files.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/IM {#MyDesktopExeName} /F', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/IM {#MyAppExeName} /F', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := '';
end;
