/*
 * JARVIS browser extension: API client (E3:D4.21). Classic script: exposes self.JarvisApi.
 * - only loopback http JARVIS URLs are used (JarvisPolicy.normalizeServerUrl); redirects are refused
 * - every payload is redacted (JarvisRedact) before it leaves the browser
 * - the browser key is sent only in the x-jarvis-browser-key header, never in a URL or a page
 */
(function (root) {
  'use strict';

  function ApiError(message, status) {
    var e = new Error(message);
    e.name = 'JarvisApiError';
    e.status = status || 0;
    return e;
  }

  /**
   * create({ getConfig: async () => ({ serverUrl, key }), fetchImpl? })
   */
  function create(options) {
    var fetchImpl = options.fetchImpl || function () { return root.fetch.apply(root, arguments); };

    async function prepare(path, method, body) {
      var config = await options.getConfig();
      var origin = root.JarvisPolicy.normalizeServerUrl(config && config.serverUrl);
      if (!origin) throw ApiError('Only a loopback JARVIS URL such as http://127.0.0.1:3000 is allowed.');
      if (!config.key) throw ApiError('No browser key is set. Create one with "npm run browser-key" and paste it in settings.');
      if (path.indexOf('/api/browser/ext/') !== 0) throw ApiError('Unsupported API path.');
      var init = {
        method: method, redirect: 'error', credentials: 'omit', cache: 'no-store',
        headers: { 'x-jarvis-browser-key': config.key }
      };
      if (body !== undefined) {
        init.headers['content-type'] = 'application/json';
        init.body = JSON.stringify(root.JarvisRedact.redactDeep(body));
      }
      return { url: origin + path, init: init };
    }

    async function failure(response) {
      var message = 'JARVIS returned HTTP ' + response.status;
      try { var data = await response.json(); if (data && typeof data.error === 'string') message = data.error; } catch (e) { /* keep default */ }
      if (response.status === 401) message = 'The browser key was rejected. Create a new key in JARVIS Studio or with "npm run browser-key".';
      return ApiError(message, response.status);
    }

    async function request(method, path, body, signal) {
      var p = await prepare(path, method, body);
      if (signal) p.init.signal = signal;
      var response;
      try { response = await fetchImpl(p.url, p.init); }
      catch (e) { if (e && e.name === 'AbortError') throw e; throw ApiError('Could not reach JARVIS at ' + p.url.split('/api/')[0] + '. Is it running?'); }
      if (!response.ok) throw await failure(response);
      return response.json();
    }

    /** POST that answers with SSE; calls onEvent(name, data) per event. */
    async function stream(path, body, onEvent, signal) {
      var p = await prepare(path, 'POST', body);
      if (signal) p.init.signal = signal;
      var response;
      try { response = await fetchImpl(p.url, p.init); }
      catch (e) { if (e && e.name === 'AbortError') throw e; throw ApiError('Could not reach JARVIS at ' + p.url.split('/api/')[0] + '. Is it running?'); }
      if (!response.ok) throw await failure(response);
      var reader = response.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';
      for (;;) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        var parts = buffer.split('\n\n');
        buffer = parts.pop();
        parts.forEach(function (block) {
          var event = 'message', data = '';
          block.split('\n').forEach(function (line) {
            if (line.indexOf('event:') === 0) event = line.slice(6).trim();
            else if (line.indexOf('data:') === 0) data += line.slice(5).trim();
          });
          if (!data) return;
          try { onEvent(event, JSON.parse(data)); } catch (e) { /* ignore malformed event */ }
        });
      }
    }

    return { request: request, stream: stream };
  }

  root.JarvisApi = { create: create };
})(typeof self !== 'undefined' ? self : globalThis);
