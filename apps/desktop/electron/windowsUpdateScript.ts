const psQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;

// WPF runs outside Mira, so Windows can replace the installed executable while
// the custom progress window remains visible. Never run the installer elevated
// ourselves: NSIS handles the existing per-user/per-machine install scope.
export function windowsUpdateScript(installer: string, executable: string, profileArg: string, parentPid: number, readyFile?: string): string {
  return `
Add-Type -AssemblyName PresentationFramework
$ErrorActionPreference = 'Stop'
$window = New-Object Windows.Window
$window.Title = 'Updating Mira'
$window.Width = 460; $window.Height = 240; $window.ResizeMode = 'NoResize'
$window.WindowStartupLocation = 'CenterScreen'
$window.Background = '#18181b'; $window.Foreground = '#fafafa'
$panel = New-Object Windows.Controls.StackPanel
$panel.Margin = '32'
$title = New-Object Windows.Controls.TextBlock
$title.Text = 'Updating Mira'; $title.FontSize = 24
$panel.Children.Add($title) | Out-Null
$status = New-Object Windows.Controls.TextBlock
$status.Text = 'Installing update. Mira will reopen automatically.'
$status.TextWrapping = 'Wrap'; $status.Margin = '0,20,0,20'
$panel.Children.Add($status) | Out-Null
$bar = New-Object Windows.Controls.ProgressBar
$bar.Height = 6; $bar.IsIndeterminate = $true
$panel.Children.Add($bar) | Out-Null
$window.Content = $panel
$script:finished = $false
$window.Add_Closing({ param($sender, $event) if (!$script:finished) { $event.Cancel = $true } })
$script:installer = $null
$script:deadline = (Get-Date).AddSeconds(60)
$timer = New-Object Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(500)
$timer.Add_Tick({
  try {
    if (!$script:installer) {
      if (Get-Process -Id ${parentPid} -ErrorAction SilentlyContinue) {
        if ((Get-Date) -gt $script:deadline) { throw 'Mira could not close. Close Mira and try again.' }
        return
      }
      $script:installer = Start-Process -FilePath ${psQuote(installer)} -ArgumentList '/S', '--updated' -PassThru
      return
    }
    if (!$script:installer.HasExited) { return }
    if ($script:installer.ExitCode -ne 0) { throw "Installer failed (exit $($script:installer.ExitCode)). Please try again." }
    Start-Process -FilePath ${psQuote(executable)} -ArgumentList ${psQuote(profileArg)}
    $script:finished = $true; $timer.Stop(); $window.Close()
  } catch {
    $script:finished = $true; $timer.Stop(); $bar.IsIndeterminate = $false
    $status.Text = $_.Exception.Message
  }
})
$window.Add_ContentRendered({ ${readyFile ? `[System.IO.File]::WriteAllText(${psQuote(readyFile)}, 'ready')` : ''} })
$timer.Start()
$window.ShowDialog() | Out-Null
Remove-Item -LiteralPath $PSScriptRoot -Recurse -Force -ErrorAction SilentlyContinue
`;
}

