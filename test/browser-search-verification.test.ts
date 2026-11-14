import test from 'node:test';
import assert from 'node:assert/strict';
import { assessBrowserNavigation } from '../src/adapters/browserSearch.js';

test('browser navigation is observed only when the expected process title changes', () => {
  assert.deepEqual(
    assessBrowserNavigation(
      { process: 'chrome', windowTitle: 'New Tab - Google Chrome' },
      { process: 'chrome', windowTitle: 'Example search results - Google Chrome' },
      'chrome.exe',
    ),
    { processMatches: true, titleChanged: true, observed: true },
  );
});

test('unchanged title is not treated as navigation evidence', () => {
  const result = assessBrowserNavigation(
    { process: 'msedge', windowTitle: 'New Tab - Microsoft Edge' },
    { process: 'msedge.exe', windowTitle: 'New Tab - Microsoft Edge' },
    'msedge',
  );
  assert.equal(result.processMatches, true);
  assert.equal(result.titleChanged, false);
  assert.equal(result.observed, false);
});

test('a title change in the wrong process is rejected', () => {
  const result = assessBrowserNavigation(
    { process: 'chrome', windowTitle: 'New Tab - Chrome' },
    { process: 'notepad', windowTitle: 'Search results' },
    'chrome',
  );
  assert.equal(result.processMatches, false);
  assert.equal(result.titleChanged, true);
  assert.equal(result.observed, false);
});

test('a mismatched baseline process also prevents navigation observation', () => {
  const result = assessBrowserNavigation(
    { process: 'notepad', windowTitle: 'Untitled - Notepad' },
    { process: 'chrome', windowTitle: 'Search results - Chrome' },
    'chrome',
  );
  assert.equal(result.processMatches, false);
  assert.equal(result.observed, false);
});

test('missing baseline or post-navigation evidence fails closed', () => {
  assert.deepEqual(assessBrowserNavigation(undefined, undefined, 'firefox'), {
    processMatches: false,
    titleChanged: false,
    observed: false,
  });
});
