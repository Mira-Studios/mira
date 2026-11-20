!include "LogicLib.nsh"
!include "nsDialogs.nsh"

!define MIRA_STARTMENU_KEY "Software\Clients\StartMenuInternet\${PRODUCT_NAME}"
!define MIRA_CAPABILITIES_KEY "${MIRA_STARTMENU_KEY}\Capabilities"
!define MIRA_REGAPP_KEY "Software\RegisteredApplications"
!define MIRA_HTML_PROGID "${APP_ID}.HTML"
!define MIRA_URL_PROGID "${APP_ID}.URL"
!define MIRA_CUSTOM_PROTOCOL "mira"
!define MIRA_EXECUTABLE_FILENAME "${PRODUCT_FILENAME}.exe"

!ifndef BUILD_UNINSTALLER
Var runShortcutPageDialog
Var runShortcutDesktopCheckbox
Var runShortcutTaskbarCheckbox
Var runShortcutDesktopState
Var runShortcutTaskbarState
Var runShortcutShouldPrompt

!macro customInit
  StrCpy $runShortcutDesktopState ${BST_CHECKED}
  StrCpy $runShortcutTaskbarState ${BST_UNCHECKED}
  StrCpy $runShortcutShouldPrompt "true"

  ReadRegStr $0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${if} $0 != ""
    StrCpy $runShortcutShouldPrompt "false"
  ${else}
    ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${if} $0 != ""
      StrCpy $runShortcutShouldPrompt "false"
    ${else}
      ReadRegStr $0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
      ${if} $0 != ""
        StrCpy $runShortcutShouldPrompt "false"
      ${endif}
    ${endif}
  ${endif}
!macroend

!macro customPageAfterChangeDir
  Page custom ShortcutOptionsPageCreate ShortcutOptionsPageLeave
!macroend

Function ShortcutOptionsPageCreate
  ${if} ${isUpdated}
    Abort
  ${endif}
  ${if} $runShortcutShouldPrompt != "true"
    Abort
  ${endif}

  nsDialogs::Create 1018
  Pop $runShortcutPageDialog
  ${If} $runShortcutPageDialog == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 24u "Choose additional Windows shortcuts:"
  Pop $0

  ${NSD_CreateCheckbox} 0 30u 100% 12u "Create a desktop shortcut"
  Pop $runShortcutDesktopCheckbox
  ${NSD_SetState} $runShortcutDesktopCheckbox $runShortcutDesktopState

  ${NSD_CreateCheckbox} 0 48u 100% 12u "Pin Mira to the taskbar"
  Pop $runShortcutTaskbarCheckbox
  ${NSD_SetState} $runShortcutTaskbarCheckbox $runShortcutTaskbarState

  nsDialogs::Show
FunctionEnd

Function ShortcutOptionsPageLeave
  ${if} ${isUpdated}
    Return
  ${endif}

  ${NSD_GetState} $runShortcutDesktopCheckbox $runShortcutDesktopState
  ${NSD_GetState} $runShortcutTaskbarCheckbox $runShortcutTaskbarState
FunctionEnd

Function RegisterDefaultBrowser
  ; ProgIDs
  WriteRegStr SHELL_CONTEXT "Software\Classes\${MIRA_HTML_PROGID}" "" "${PRODUCT_NAME} Document"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${MIRA_HTML_PROGID}\DefaultIcon" "" "$INSTDIR\${MIRA_EXECUTABLE_FILENAME},0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${MIRA_HTML_PROGID}\shell\open\command" "" '"$INSTDIR\${MIRA_EXECUTABLE_FILENAME}" "%1"'
  WriteRegStr SHELL_CONTEXT "Software\Classes\${MIRA_URL_PROGID}" "" "${PRODUCT_NAME} URL"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${MIRA_URL_PROGID}" "URL Protocol" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\${MIRA_URL_PROGID}\DefaultIcon" "" "$INSTDIR\${MIRA_EXECUTABLE_FILENAME},0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${MIRA_URL_PROGID}\shell\open\command" "" '"$INSTDIR\${MIRA_EXECUTABLE_FILENAME}" "%1"'
  WriteRegStr SHELL_CONTEXT "Software\Classes\${MIRA_CUSTOM_PROTOCOL}" "" "URL:${PRODUCT_NAME} URL"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${MIRA_CUSTOM_PROTOCOL}" "URL Protocol" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\${MIRA_CUSTOM_PROTOCOL}\DefaultIcon" "" "$INSTDIR\${MIRA_EXECUTABLE_FILENAME},0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${MIRA_CUSTOM_PROTOCOL}\shell\open\command" "" '"$INSTDIR\${MIRA_EXECUTABLE_FILENAME}" "%1"'

  ; Start menu internet registration
  WriteRegStr SHELL_CONTEXT "${MIRA_STARTMENU_KEY}" "" "${PRODUCT_NAME}"
  WriteRegStr SHELL_CONTEXT "${MIRA_STARTMENU_KEY}\DefaultIcon" "" "$INSTDIR\${MIRA_EXECUTABLE_FILENAME},0"
  WriteRegStr SHELL_CONTEXT "${MIRA_STARTMENU_KEY}\shell\open\command" "" '"$INSTDIR\${MIRA_EXECUTABLE_FILENAME}"'

  ; Default apps capabilities
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}" "ApplicationName" "${PRODUCT_NAME}"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}" "ApplicationDescription" "${APP_DESCRIPTION}"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}" "ApplicationIcon" "$INSTDIR\${MIRA_EXECUTABLE_FILENAME},0"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}\FileAssociations" ".htm" "${MIRA_HTML_PROGID}"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}\FileAssociations" ".html" "${MIRA_HTML_PROGID}"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}\FileAssociations" ".shtml" "${MIRA_HTML_PROGID}"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}\FileAssociations" ".xht" "${MIRA_HTML_PROGID}"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}\FileAssociations" ".xhtml" "${MIRA_HTML_PROGID}"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}\FileAssociations" ".pdf" "${MIRA_HTML_PROGID}"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}\FileAssociations" ".svg" "${MIRA_HTML_PROGID}"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}\FileAssociations" ".mht" "${MIRA_HTML_PROGID}"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}\FileAssociations" ".mhtml" "${MIRA_HTML_PROGID}"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}\FileAssociations" ".xml" "${MIRA_HTML_PROGID}"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}\FileAssociations" ".txt" "${MIRA_HTML_PROGID}"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}\FileAssociations" ".text" "${MIRA_HTML_PROGID}"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}\FileAssociations" ".md" "${MIRA_HTML_PROGID}"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}\FileAssociations" ".markdown" "${MIRA_HTML_PROGID}"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}\FileAssociations" ".json" "${MIRA_HTML_PROGID}"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}\FileAssociations" ".jsonc" "${MIRA_HTML_PROGID}"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}\FileAssociations" ".js" "${MIRA_HTML_PROGID}"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}\FileAssociations" ".jsx" "${MIRA_HTML_PROGID}"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}\FileAssociations" ".mjs" "${MIRA_HTML_PROGID}"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}\FileAssociations" ".cjs" "${MIRA_HTML_PROGID}"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}\FileAssociations" ".ts" "${MIRA_HTML_PROGID}"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}\FileAssociations" ".tsx" "${MIRA_HTML_PROGID}"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}\FileAssociations" ".css" "${MIRA_HTML_PROGID}"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}\FileAssociations" ".scss" "${MIRA_HTML_PROGID}"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}\FileAssociations" ".less" "${MIRA_HTML_PROGID}"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}\FileAssociations" ".yaml" "${MIRA_HTML_PROGID}"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}\FileAssociations" ".yml" "${MIRA_HTML_PROGID}"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}\FileAssociations" ".toml" "${MIRA_HTML_PROGID}"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}\FileAssociations" ".ini" "${MIRA_HTML_PROGID}"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}\FileAssociations" ".conf" "${MIRA_HTML_PROGID}"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}\FileAssociations" ".cfg" "${MIRA_HTML_PROGID}"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}\FileAssociations" ".log" "${MIRA_HTML_PROGID}"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}\FileAssociations" ".csv" "${MIRA_HTML_PROGID}"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}\FileAssociations" ".tsv" "${MIRA_HTML_PROGID}"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}\FileAssociations" ".py" "${MIRA_HTML_PROGID}"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}\FileAssociations" ".rs" "${MIRA_HTML_PROGID}"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}\FileAssociations" ".go" "${MIRA_HTML_PROGID}"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}\FileAssociations" ".java" "${MIRA_HTML_PROGID}"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}\FileAssociations" ".c" "${MIRA_HTML_PROGID}"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}\FileAssociations" ".h" "${MIRA_HTML_PROGID}"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}\FileAssociations" ".cpp" "${MIRA_HTML_PROGID}"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}\FileAssociations" ".hpp" "${MIRA_HTML_PROGID}"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}\FileAssociations" ".cs" "${MIRA_HTML_PROGID}"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}\FileAssociations" ".sh" "${MIRA_HTML_PROGID}"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}\FileAssociations" ".bash" "${MIRA_HTML_PROGID}"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}\FileAssociations" ".ps1" "${MIRA_HTML_PROGID}"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}\FileAssociations" ".sql" "${MIRA_HTML_PROGID}"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}\FileAssociations" ".rb" "${MIRA_HTML_PROGID}"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}\FileAssociations" ".php" "${MIRA_HTML_PROGID}"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}\FileAssociations" ".vue" "${MIRA_HTML_PROGID}"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}\FileAssociations" ".svelte" "${MIRA_HTML_PROGID}"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}\URLAssociations" "http" "${MIRA_URL_PROGID}"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}\URLAssociations" "https" "${MIRA_URL_PROGID}"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}\URLAssociations" "mailto" "${MIRA_URL_PROGID}"
  WriteRegStr SHELL_CONTEXT "${MIRA_CAPABILITIES_KEY}\URLAssociations" "mira" "${MIRA_CUSTOM_PROTOCOL}"
  WriteRegStr SHELL_CONTEXT "${MIRA_REGAPP_KEY}" "${PRODUCT_NAME}" "${MIRA_CAPABILITIES_KEY}"

  ; Notify shell to refresh registered apps
  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
FunctionEnd

!macro customInstall
  Call RegisterDefaultBrowser
  ${ifNot} ${isUpdated}
    ${if} $runShortcutShouldPrompt == "true"
    ${if} $runShortcutDesktopState == ${BST_CHECKED}
      CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
      System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
    ${endif}

    ${if} $runShortcutTaskbarState == ${BST_CHECKED}
      ${StdUtils.InvokeShellVerb} $0 "$INSTDIR" "${MIRA_EXECUTABLE_FILENAME}" ${StdUtils.Const.ShellVerb.PinToTaskbar}
    ${endif}
    ${endif}
  ${endif}
!macroend
!else

!macro customUninstall
  DeleteRegKey SHELL_CONTEXT "Software\Classes\${MIRA_HTML_PROGID}"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\${MIRA_URL_PROGID}"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\${MIRA_CUSTOM_PROTOCOL}"
  DeleteRegKey SHELL_CONTEXT "${MIRA_STARTMENU_KEY}"
  DeleteRegValue SHELL_CONTEXT "${MIRA_REGAPP_KEY}" "${PRODUCT_NAME}"
  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend

!endif
