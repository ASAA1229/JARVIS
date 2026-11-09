import test from 'node:test';
import assert from 'node:assert/strict';
import { PACKAGED_APP_ID, appIdProcessIdentity, discoveredLaunchResult, processIdentityFromExecutable } from '../src/adapters/windowsAppLauncher.js';
import { VerificationOutcome } from '../src/core/types.js';

test('executable-path AppIDs yield their basename as process identity', () => {
  assert.deepEqual(appIdProcessIdentity('{6D809377-6AF0-444B-8957-A3773F02200E}\Notepad++\notepad++.exe'), { processNames: ['notepad++'] });
  assert.deepEqual(appIdProcessIdentity('C:\Tools\VLC\vlc.exe'), { processNames: ['vlc'] });
  assert.equal(appIdProcessIdentity('Chrome'), undefined);
  assert.equal(appIdProcessIdentity('Microsoft.WindowsCalculator_8wekyb3d8bbwe!App'), undefined);
});

test('shell hosts and templated executables are never accepted as identity', () => {
  assert.equal(appIdProcessIdentity('C:\Windows\explorer.exe'), undefined);
  assert.equal(processIdentityFromExecutable('ApplicationFrameHost.exe'), undefined);
  assert.equal(processIdentityFromExecutable('$targetnametoken$.exe'), undefined);
  assert.deepEqual(processIdentityFromExecutable('VFS\ProgramFilesX64\App\Spotify.exe'), { processNames: ['Spotify'] });
});

test('packaged AUMID pattern rejects injection characters', () => {
  assert.ok(PACKAGED_APP_ID.test('SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify'));
  assert.equal(PACKAGED_APP_ID.test("Evil_zpdnekdrzrea0!App'; Remove-Item"), false);
  assert.equal(PACKAGED_APP_ID.test('NoFamily!App'), false);
});

test('derived identity verifies only a window owned by the expected process', () => {
  const selected = { Name: 'VLC media player', AppID: 'C:\Tools\VLC\vlc.exe' };
  const identity = appIdProcessIdentity(selected.AppID);
  const verified = discoveredLaunchResult(selected, { pid: 10, processName: 'vlc', title: 'VLC media player' } as never, identity);
  assert.equal(verified.outcome, VerificationOutcome.VERIFIED_SUCCESS);
  const foreign = discoveredLaunchResult(selected, { pid: 11, processName: 'notepad', title: 'VLC media player' } as never, identity);
  assert.equal(foreign.outcome, VerificationOutcome.PARTIAL_SUCCESS);
});


test('AppID identity derivation rejects empty, non-executable and malformed path inputs', () => {
  for (const value of ['', '   ', 'Notepad', 'Vendor.App!Main', 'C:\\Tools\\Editor.exe --unsafe', 'C:\\Tools\\$placeholder$.exe']) {
    assert.equal(appIdProcessIdentity(value), undefined, value);
  }
});

test('shell-host executable identity rejection is case-insensitive', () => {
  for (const executable of ['EXPLORER.exe', 'ApplicationFrameHost.exe', 'POWERSHELL.exe', 'RUNDLL32.exe']) {
    assert.equal(processIdentityFromExecutable(executable), undefined, executable);
  }
});

test('AppID identity is derived from the final executable path segment only', () => {
  assert.deepEqual(
    appIdProcessIdentity('C:\\Program Files\\Vendor\\Editor\\editor.exe'),
    { processNames: ['editor'] },
  );
  assert.deepEqual(
    appIdProcessIdentity('{6D809377-6AF0-444B-8957-A3773F02200E}\\Vendor\\Editor.exe'),
    { processNames: ['Editor'] },
  );
});
