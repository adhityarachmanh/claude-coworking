; 📦 Inno Setup script for Adhit Office (Windows, per-user, no admin).
; Build: node scripts/build-windows.mjs   (runs ISCC when installed)
; Output: dist/installer/AdhitOffice-Setup-<version>.exe
#ifndef MyAppVersion
  #define MyAppVersion "0.2.0"
#endif
#define MyAppName "Adhit Office"
#define MyAppPublisher "Adhit"
#define MyAppExeName "AdhitOffice.exe"
#define BuildDir "..\dist\AdhitOffice"

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
Name: "desktopicon"; Description: "Buat shortcut di Desktop"; GroupDescription: "Shortcut:"; Flags: unchecked
Name: "autostart"; Description: "Jalankan Adhit Office saat login Windows"; GroupDescription: "Startup:"; Flags: unchecked

[Files]
Source: "{#BuildDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"
Name: "{group}\Cara pakai"; Filename: "{app}\CARA-PAKAI.txt"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon
Name: "{userstartup}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Parameters: "--background"; WorkingDir: "{app}"; Tasks: autostart

[Run]
Filename: "{app}\{#MyAppExeName}"; Parameters: "--background"; Description: "Jalankan Adhit Office sekarang (buka http://127.0.0.1:4317)"; Flags: postinstall nowait skipifsilent
Filename: "http://127.0.0.1:4317"; Description: "Buka kantor di browser"; Flags: postinstall shellexec nowait skipifsilent unchecked
; Silent update: no finished page, so start the new server explicitly after the files are replaced.
Filename: "{app}\{#MyAppExeName}"; Parameters: "--background"; Flags: nowait runhidden; Check: WizardSilent

[UninstallRun]
Filename: "{sys}\taskkill.exe"; Parameters: "/IM {#MyAppExeName} /F"; Flags: runhidden; RunOnceId: "StopAdhitOffice"

[Code]
// A running server keeps the .exe locked: ask Inno to close it before replacing files.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/IM {#MyAppExeName} /F', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := '';
end;
