/*
 * MagicPods menu for Steam's VR UI (ARM64 SteamOS, e.g. Steam Frame).
 *
 * Injected into two Steam pages by magicpods-steamui.py:
 *  - the VR bottom bar (valve.steam.gamepadui.bar): an earbuds battery indicator next to
 *    the headset battery; a click opens the quick-access popup on the MagicPods tab;
 *  - the quick-access popup (valve.steam.gamepadui.barpopup.*): a MagicPods tab with
 *    the same menus as the MagicPods Decky plugin, plus an earbuds row in Battery Info.
 * It talks to MagicPodsCore directly over ws://127.0.0.1:2020. The two pages signal
 * each other over a BroadcastChannel (same origin).
 *
 * Unofficial: Steam's markup can change in an update. Everything is located
 * defensively; if an anchor is missing, nothing is added.
 *
 * License: GPL-3.0. Noise-mode icons and labels follow MagicPodsDecky (GPL-3.0).
 */
(() => {
  const VERSION = '__VERSION__';
  const prev = window.__magicpodsMenu;
  if (prev && prev.version === VERSION) { prev.ensure(); return 'already ' + VERSION; }
  if (prev && prev.teardown) { try { prev.teardown(); } catch (e) { } }

  const CORE_URL = 'ws://127.0.0.1:2020/';
  // Steam names these overlay pages "SteamVR - valve.steam.gamepadui.bar (id)" and
  // "SteamVR - valve.steam.gamepadui.barpopup.<id> (id)".
  const ROLE = /gamepadui\.barpopup\./.test(document.title) ? 'popup'
    : (/gamepadui\.bar(?!popup)/.test(document.title) ? 'bar'
      : (document.title === 'SharedJSContext' ? 'shared' : 'other'));
  if (ROLE === 'other') return 'not a target page';
  if (ROLE === 'shared') {
    // Reserved for later use; nothing runs here now (alerts are SteamVR notifications).
    window.__magicpodsMenu = { version: VERSION, role: ROLE, ensure() { }, teardown() { delete window.__magicpodsMenu; } };
    return 'installed ' + VERSION + ' (shared, idle)';
  }
  if (!document.body) return 'not ready';

  const cleanups = [];
  let dead = false;  // set by teardown: late callbacks (e.g. socket close) must not redraw
  try {
  const channel = new BroadcastChannel('magicpods');
  cleanups.push(() => channel.close());

  // ---------- settings kept in this browser profile (shared by both pages) ----------
  const DEFAULTS = {
    low_battery: 30, allow_off: true, allow_transparency: true, allow_adaptive: true,
    allow_wind: true, allow_anc: true, tab: 'device', auto_tab: true, click_action: 'menu',
  };
  function loadSettings() {
    try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem('magicpods.settings') || '{}')); }
    catch (e) { return Object.assign({}, DEFAULTS); }
  }
  let settings = loadSettings();
  function saveSettings(patch) {
    settings = Object.assign({}, settings, patch);
    try { localStorage.setItem('magicpods.settings', JSON.stringify(settings)); } catch (e) { }
    channel.postMessage({ type: 'settings' });
    render();
  }

  // ---------- MagicPodsCore client ----------
  const core = { ws: null, ready: false, version: null, info: null, headphones: null, bluetooth: null,
    coreSettings: {}, frameSettings: {}, timer: null, closed: false };
  function coreConnect() {
    if (core.closed) return;
    clearTimeout(core.timer);
    if (core.ws) {  // drop any previous socket first, so only one is ever live
      const old = core.ws;
      core.ws = null;
      old.onmessage = old.onclose = old.onerror = null;
      try { old.close(); } catch (e) { }
    }
    let ws;
    try { ws = new WebSocket(CORE_URL); } catch (e) { scheduleReconnect(); return; }
    core.ws = ws;
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.init) {
        if (msg.init.api !== 1) { core.ready = false; core.badVersion = true; render(); return; }
        core.ready = true; core.badVersion = false; core.version = msg.init.version;
        coreSend('GetAll');
        coreSend('GetSetting', { container: 'magicpods', setting: 'animation' });
        coreSend('GetSetting', { container: 'magicpods', setting: 'logLevel' });
        coreSend('GetSetting', { container: 'magicpodsframe', setting: 'standby_fix' });
        coreSend('GetSetting', { container: 'magicpodsframe', setting: 'low_battery' });
        coreSend('GetSetting', { container: 'magicpodsframe', setting: 'auto_update' });
        coreSend('GetSetting', { container: 'magicpodsframe', setting: 'update_request' });
        coreSend('GetSetting', { container: 'magicpodsframe', setting: 'update_status' });
        render();
        return;
      }
      if (!core.ready) return;
      if ('info' in msg) core.info = (msg.info && Object.keys(msg.info).length) ? msg.info : null;
      if ('headphones' in msg) { core.headphones = Array.isArray(msg.headphones) ? msg.headphones : []; clearPending(); }
      if ('defaultbluetooth' in msg) core.bluetooth = (msg.defaultbluetooth && 'enabled' in msg.defaultbluetooth) ? msg.defaultbluetooth : null;
      if (msg.settings && msg.settings.magicpods) Object.assign(core.coreSettings, msg.settings.magicpods);
      if (msg.settings && msg.settings.magicpodsframe) Object.assign(core.frameSettings, msg.settings.magicpodsframe);
      render();
    };
    ws.onclose = () => {
      if (core.ws !== ws) return;  // a socket we already replaced
      core.ws = null; core.ready = false; core.info = null; core.headphones = null; core.bluetooth = null;
      scheduleReconnect();
      try { render(); } catch (e) { }
    };
    ws.onerror = () => { };
  }
  function scheduleReconnect() {
    if (core.closed) return;
    clearTimeout(core.timer);
    core.timer = setTimeout(coreConnect, 4000);
  }
  function coreSend(method, args) {
    if (!core.ws || core.ws.readyState !== 1) return false;
    core.ws.send(JSON.stringify(args ? { method, arguments: args } : { method }));
    return true;
  }
  function setCapability(key, selected) {
    if (!core.info) return;
    const caps = core.info.capabilities || {};
    if (caps[key]) {  // optimistic; merge partial objects such as {left: 5}
      const cur = caps[key].selected;
      const merged = (selected && typeof selected === 'object' && cur && typeof cur === 'object') ? Object.assign({}, cur, selected) : selected;
      caps[key] = Object.assign({}, caps[key], { selected: merged });
    }
    coreSend('SetCapabilities', { address: core.info.address, capabilities: { [key]: { selected } } });
    render();
  }
  const debouncers = {};
  function debounced(key, fn) {
    clearTimeout(debouncers[key]);
    debouncers[key] = setTimeout(fn, 350);
  }
  cleanups.push(() => {
    core.closed = true; clearTimeout(core.timer);
    for (const k of Object.keys(debouncers)) clearTimeout(debouncers[k]);
    if (core.ws) { core.ws.onmessage = core.ws.onclose = core.ws.onerror = null; core.ws.close(); core.ws = null; }
  });
  // Current selected value of a multi-field capability, read at send time (not at render).
  const live = (key) => ((core.info && core.info.capabilities && core.info.capabilities[key]) || {}).selected || {};

  // ---------- battery helpers ----------
  const OK = (c) => c && (c.status === 2 || c.status === 3) && typeof c.battery === 'number';
  function buds() {
    const b = core.info && core.info.capabilities && core.info.capabilities.battery;
    if (!b) return null;
    const list = [['single', 'Charge'], ['left', 'Left'], ['right', 'Right'], ['case', 'Case']]
      .filter(([k]) => OK(b[k])).map(([k, label]) => Object.assign({ key: k, label }, b[k]));
    return list.length ? list : null;
  }
  function lowThreshold() {
    const v = core.frameSettings && core.frameSettings.low_battery;
    return typeof v === 'number' ? v : 30;
  }
  function isLow(c) {
    const t = lowThreshold();
    return t > 0 && c.status === 2 && !c.charging && c.battery !== 0 && c.battery <= t;
  }

  // ---------- icons ----------
  const ANC_MODES = [
    { bit: 1, key: 'off', label: 'Off', path: 'M8.9948 5.9948C10.6545 4.33507 13.3455 4.33507 15.0052 5.9948C16.6649 7.65453 16.6649 10.3455 15.0052 12.0052C13.3455 13.6649 10.6545 13.6649 8.9948 12.0052C7.33507 10.3455 7.33507 7.65453 8.9948 5.9948ZM12 14.7578C9.86712 14.7578 7.7321 15.2735 6.10466 16.2209C4.48397 17.1644 3.25 18.6181 3.25 20.4998V21.4998C3.25 22.466 4.03379 23.2498 5 23.2498H19C19.9662 23.2498 20.75 22.466 20.75 21.4998V20.4998C20.75 18.6181 19.516 17.1644 17.8953 16.2209C16.2679 15.2735 14.1329 14.7578 12 14.7578Z' },
    { bit: 2, key: 'transparency', label: 'Transparency', path: 'M11.4934 1.26437C11.661 1.25354 11.8299 1.24805 12 1.24805C12.1701 1.24805 12.339 1.25354 12.5066 1.26437C12.92 1.29108 13.2334 1.64782 13.2067 2.06117C13.18 2.47452 12.8232 2.78796 12.4099 2.76125C12.2745 2.7525 12.1378 2.74805 12 2.74805C11.8622 2.74805 11.7255 2.7525 11.5901 2.76125C11.1768 2.78796 10.82 2.47452 10.7933 2.06117C10.7666 1.64782 11.08 1.29108 11.4934 1.26437ZM14.4243 2.38631C14.6078 2.01495 15.0576 1.86264 15.4289 2.04612C15.7334 2.19656 16.0265 2.36635 16.3065 2.55386C16.6507 2.7843 16.743 3.25013 16.5125 3.59433C16.2821 3.93853 15.8163 4.03075 15.4721 3.80032C15.2461 3.64903 15.0098 3.51214 14.7645 3.39093C14.3931 3.20745 14.2408 2.75766 14.4243 2.38631ZM9.57571 2.38631C9.75919 2.75766 9.60689 3.20745 9.23553 3.39093C8.99021 3.51214 8.7539 3.64903 8.52793 3.80032C8.18373 4.03075 7.7179 3.93853 7.48746 3.59433C7.25703 3.25013 7.34925 2.7843 7.69345 2.55386C7.97354 2.36635 8.26662 2.19656 8.57108 2.04612C8.94244 1.86264 9.39223 2.01495 9.57571 2.38631ZM17.4037 4.48551C17.7479 4.25508 18.2137 4.3473 18.4442 4.6915C18.6317 4.97159 18.8015 5.26467 18.9519 5.56913C19.1354 5.94049 18.9831 6.39028 18.6117 6.57376C18.2404 6.75724 17.7906 6.60494 17.6071 6.23358C17.4859 5.98825 17.349 5.75195 17.1977 5.52598C16.9673 5.18178 17.0595 4.71595 17.4037 4.48551ZM6.59628 4.48551C6.94048 4.71595 7.0327 5.18178 6.80227 5.52598C6.65098 5.75195 6.5141 5.98825 6.39289 6.23358C6.2094 6.60494 5.75962 6.75724 5.38826 6.57376C5.0169 6.39028 4.8646 5.94049 5.04808 5.56913C5.19851 5.26467 5.3683 4.97159 5.55582 4.6915C5.78625 4.3473 6.25208 4.25508 6.59628 4.48551ZM18.9369 7.79135C19.3502 7.76464 19.707 8.07807 19.7337 8.49142C19.7445 8.659 19.75 8.82794 19.75 8.99805C19.75 9.16816 19.7445 9.33709 19.7337 9.50467C19.707 9.91803 19.3502 10.2315 18.9369 10.2047C18.5235 10.178 18.2101 9.82129 18.2368 9.40794C18.2456 9.27254 18.25 9.13587 18.25 8.99805C18.25 8.86023 18.2456 8.72356 18.2368 8.58815C18.2101 8.1748 18.5235 7.81806 18.9369 7.79135ZM5.06313 7.79135C5.47648 7.81806 5.78991 8.1748 5.7632 8.58815C5.75445 8.72356 5.75 8.86023 5.75 8.99805C5.75 9.13587 5.75445 9.27254 5.7632 9.40794C5.78991 9.82129 5.47648 10.178 5.06313 10.2047C4.64978 10.2315 4.29303 9.91803 4.26632 9.50467C4.25549 9.33709 4.25 9.16816 4.25 8.99805C4.25 8.82794 4.25549 8.659 4.26632 8.49142C4.29303 8.07807 4.64978 7.76464 5.06313 7.79135ZM18.6117 11.4223C18.9831 11.6058 19.1354 12.0556 18.9519 12.427C18.8015 12.7314 18.6317 13.0245 18.4442 13.3046C18.2137 13.6488 17.7479 13.741 17.4037 13.5106C17.0595 13.2801 16.9673 12.8143 17.1977 12.4701C17.349 12.2441 17.4859 12.0078 17.6071 11.7625C17.7906 11.3912 18.2404 11.2389 18.6117 11.4223ZM5.38826 11.4223C5.75962 11.2389 6.2094 11.3912 6.39289 11.7625C6.5141 12.0078 6.65098 12.2441 6.80227 12.4701C7.0327 12.8143 6.94048 13.2801 6.59628 13.5106C6.25208 13.741 5.78625 13.6488 5.55582 13.3046C5.3683 13.0245 5.19851 12.7314 5.04808 12.427C4.8646 12.0556 5.0169 11.6058 5.38826 11.4223ZM15.0052 5.9948C13.3455 4.33507 10.6545 4.33507 8.9948 5.9948C7.33507 7.65453 7.33507 10.3455 8.9948 12.0052C10.6545 13.6649 13.3455 13.6649 15.0052 12.0052C16.6649 10.3455 16.6649 7.65453 15.0052 5.9948ZM6.10466 16.2209C7.7321 15.2735 9.86712 14.7578 12 14.7578C14.1329 14.7578 16.2679 15.2735 17.8953 16.2209C19.516 17.1644 20.75 18.6181 20.75 20.4998V21.4998C20.75 22.466 19.9662 23.2498 19 23.2498H5C4.03379 23.2498 3.25 22.466 3.25 21.4998V20.4998C3.25 18.6181 4.48397 17.1644 6.10466 16.2209Z' },
    { bit: 4, key: 'adaptive', label: 'Adaptive', path: 'M16.5624 5.3114C16.2937 5.13073 16.013 4.96625 15.7216 4.81928C15.642 4.7791 15.5615 4.74023 15.4803 4.7027C15.3139 4.62579 15.3139 4.37389 15.4803 4.29699L15.4957 4.28983C15.5717 4.25452 15.647 4.21804 15.7216 4.18041C16.013 4.03344 16.2937 3.86896 16.5624 3.68829C16.5961 3.66562 16.6297 3.64269 16.663 3.61951C17.4262 3.08892 18.0889 2.4262 18.6195 1.66302C18.6427 1.62968 18.6656 1.59615 18.6883 1.56243C18.869 1.29372 19.0334 1.01301 19.1804 0.721632C19.2206 0.641973 19.2595 0.561518 19.297 0.480292C19.3739 0.313861 19.6258 0.313861 19.7027 0.480292C19.7402 0.561518 19.7791 0.641973 19.8193 0.721631C19.9662 1.01301 20.1307 1.29372 20.3114 1.56243C20.3341 1.59615 20.357 1.62968 20.3802 1.66302C20.9108 2.4262 21.5735 3.08892 22.3367 3.61951C22.37 3.64269 22.4035 3.66562 22.4373 3.68829C22.706 3.86896 22.9867 4.03344 23.2781 4.18041L23.2992 4.19105C23.372 4.22746 23.4454 4.26278 23.5194 4.29699C23.6858 4.37389 23.6858 4.62579 23.5194 4.7027C23.4382 4.74023 23.3577 4.7791 23.2781 4.81928C22.9867 4.96625 22.706 5.13073 22.4373 5.3114C22.4035 5.33407 22.37 5.35699 22.3367 5.38017C21.5735 5.91076 20.9108 6.57349 20.3802 7.33667C20.357 7.37001 20.3341 7.40354 20.3114 7.43726C20.1307 7.70596 19.9662 7.98668 19.8193 8.27806C19.7791 8.35771 19.7402 8.43817 19.7027 8.51939C19.6258 8.68583 19.3739 8.68583 19.297 8.51939C19.2595 8.43817 19.2206 8.35771 19.1804 8.27806C19.0334 7.98668 18.869 7.70596 18.6883 7.43726C18.6656 7.40354 18.6427 7.37001 18.6195 7.33667C18.0889 6.57349 17.4262 5.91076 16.663 5.38017C16.6297 5.35699 16.5961 5.33407 16.5624 5.3114ZM16.1002 2.42226C15.7394 2.69174 15.3493 2.92476 14.9352 3.11611C14.8137 3.17224 14.7048 3.24062 14.6085 3.31869C13.8146 2.9536 12.9311 2.75 12 2.75C8.54822 2.75 5.75 5.54822 5.75 9C5.75 10.7244 6.44835 12.2857 7.57765 13.4165C7.05809 13.5781 6.55333 13.7693 6.07018 13.9902C4.93438 12.642 4.25 10.9009 4.25 9C4.25 4.71979 7.71979 1.25 12 1.25C13.5056 1.25 14.9109 1.67934 16.1002 2.42226ZM19.6946 9.93141C19.1534 9.99861 18.5802 9.78414 18.2435 9.28799C18.1705 10.8978 17.4884 12.349 16.4223 13.4165C16.9419 13.5781 17.4467 13.7693 17.9298 13.9902C18.8773 12.8655 19.5106 11.4675 19.6946 9.93141ZM8.9948 5.9948C10.6545 4.33507 13.3455 4.33507 15.0052 5.9948C16.6649 7.65453 16.6649 10.3455 15.0052 12.0052C13.3455 13.6649 10.6545 13.6649 8.9948 12.0052C7.33507 10.3455 7.33507 7.65453 8.9948 5.9948ZM12 14.7578C9.86712 14.7578 7.7321 15.2735 6.10466 16.2209C4.48397 17.1644 3.25 18.6181 3.25 20.4998V21.4998C3.25 22.466 4.03379 23.2498 5 23.2498H19C19.9662 23.2498 20.75 22.466 20.75 21.4998V20.4998C20.75 18.6181 19.516 17.1644 17.8953 16.2209C16.2679 15.2735 14.1329 14.7578 12 14.7578Z' },
    { bit: 8, key: 'wind', label: 'Wind cancellation', path: 'M14.0056 1.51189C15.279 1.85183 16.4827 2.52158 17.4802 3.51904C18.4776 4.5165 19.1474 5.72018 19.4873 6.99361C19.5941 7.39381 19.3563 7.80484 18.9561 7.91168C18.5559 8.01851 18.1449 7.78069 18.0381 7.38049C17.7643 6.35507 17.2255 5.38569 16.4195 4.5797C15.6135 3.7737 14.6441 3.23488 13.6187 2.96114C13.2185 2.8543 12.9807 2.44327 13.0875 2.04307C13.1944 1.64287 13.6054 1.40506 14.0056 1.51189ZM10.9127 2.04307C11.0195 2.44327 10.7817 2.8543 10.3815 2.96114C9.35605 3.23488 8.38667 3.7737 7.58067 4.5797C6.77468 5.38569 6.23585 6.35507 5.96212 7.38049C5.85528 7.78069 5.44425 8.01851 5.04405 7.91168C4.64385 7.80484 4.40603 7.39381 4.51287 6.99361C4.85281 5.72018 5.52255 4.5165 6.52001 3.51904C7.51747 2.52158 8.72116 1.85183 9.99459 1.51189C10.3948 1.40506 10.8058 1.64287 10.9127 2.04307ZM18.9561 10.0866C19.3563 10.1934 19.5941 10.6044 19.4873 11.0046C19.2012 12.0763 18.6816 13.0986 17.9296 13.9901C17.4463 13.7692 16.9414 13.5779 16.4217 13.4163C17.2265 12.6107 17.7646 11.6422 18.0381 10.6177C18.1449 10.2175 18.5559 9.97972 18.9561 10.0866ZM4.51287 11.0046C4.79894 12.0763 5.31859 13.0985 6.07056 13.9901C6.55383 13.7691 7.05872 13.5779 7.5784 13.4163C6.77366 12.6107 6.23559 11.6422 5.96212 10.6177C5.85528 10.2175 5.44425 9.97972 5.04405 10.0866C4.64385 10.1934 4.40603 10.6044 4.51287 11.0046ZM15.0052 5.9948C13.3455 4.33507 10.6545 4.33507 8.9948 5.9948C7.33507 7.65453 7.33507 10.3455 8.9948 12.0052C10.6545 13.6649 13.3455 13.6649 15.0052 12.0052C16.6649 10.3455 16.6649 7.65453 15.0052 5.9948ZM6.10466 16.2209C7.7321 15.2735 9.86712 14.7578 12 14.7578C14.1329 14.7578 16.2679 15.2735 17.8953 16.2209C19.516 17.1644 20.75 18.6181 20.75 20.4998V21.4998C20.75 22.466 19.9662 23.2498 19 23.2498H5C4.03379 23.2498 3.25 22.466 3.25 21.4998V20.4998C3.25 18.6181 4.48397 17.1644 6.10466 16.2209Z' },
    { bit: 16, key: 'anc', label: 'Noise cancellation', path: 'M12 2.75C8.54822 2.75 5.75 5.54822 5.75 9C5.75 10.7244 6.44835 12.2857 7.57765 13.4165C7.05809 13.5781 6.55333 13.7693 6.07018 13.9902C4.93438 12.642 4.25 10.9009 4.25 9C4.25 4.71979 7.71979 1.25 12 1.25C16.2802 1.25 19.75 4.71979 19.75 9C19.75 10.9009 19.0656 12.642 17.9298 13.9902C17.4467 13.7693 16.9419 13.5781 16.4223 13.4165C17.5517 12.2857 18.25 10.7244 18.25 9C18.25 5.54822 15.4518 2.75 12 2.75ZM15.0052 5.9948C13.3455 4.33507 10.6545 4.33507 8.9948 5.9948C7.33507 7.65453 7.33507 10.3455 8.9948 12.0052C10.6545 13.6649 13.3455 13.6649 15.0052 12.0052C16.6649 10.3455 16.6649 7.65453 15.0052 5.9948ZM6.10466 16.2209C7.7321 15.2735 9.86712 14.7578 12 14.7578C14.1329 14.7578 16.2679 15.2735 17.8953 16.2209C19.516 17.1644 20.75 18.6181 20.75 20.4998V21.4998C20.75 22.466 19.9662 23.2498 19 23.2498H5C4.03379 23.2498 3.25 22.466 3.25 21.4998V20.4998C3.25 18.6181 4.48397 17.1644 6.10466 16.2209Z' },
  ];
  const HOLD_MODES = [  // pressAndHoldAirPodModeAnc uses a different bitmask
    { bit: 1, key: 'off' }, { bit: 4, key: 'transparency' }, { bit: 8, key: 'adaptive' }, { bit: 2, key: 'anc' },
  ];
  const svgPath = (d, size = 22) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="${d}" fill="currentColor"/></svg>`;
  const EARBUDS_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">' +
    '<circle cx="7" cy="6.5" r="4"/><rect x="7.6" y="7" width="3" height="13" rx="1.5"/>' +
    '<circle cx="17" cy="6.5" r="4"/><rect x="13.4" y="7" width="3" height="13" rx="1.5"/></svg>';
  // Decky's header battery icon: a horizontal battery with one bar per earbud.
  function headerBatteryIcon(pods) {
    const w = (v) => Math.max(0, Math.min(18, v * 0.18)).toFixed(2);
    const col = (c) => (isLow(c) ? '#ED18BF' : '#1B9EFA');
    const left = pods.find((c) => c.key === 'left'), right = pods.find((c) => c.key === 'right');
    const style = 'width:28px;height:16px;flex:0 0 auto;transform:scale(0.9166667);transform-origin:center';
    if (left && right) {
      return `<svg style="${style}" width="28" height="16" viewBox="0 0 28 16" fill="none"><rect x="4" y="3" width="${w(left.battery)}" height="3" fill="${col(left)}"/>` +
        `<rect x="4" y="10" width="${w(right.battery)}" height="3" fill="${col(right)}"/>` +
        `<path d="M26 5.33301H28V10.667H26V16H0V0H26V5.33301ZM2 8.75V14H24V8.75H2ZM2 7.25H24V2H2V7.25Z" fill="currentColor"/></svg>`;
    }
    const one = left || right || pods[0];
    return `<svg style="${style}" width="28" height="16" viewBox="0 0 28 16" fill="none"><rect x="4" y="4" width="${w(one.battery)}" height="8" fill="${col(one)}"/>` +
      `<path fill-rule="evenodd" clip-rule="evenodd" d="M26 0H0V16H26V10.6667H28V5.33333H26V0ZM24 2H2V14H24V2Z" fill="currentColor"/></svg>`;
  }
  function batteryIcon(c) {
    const h = Math.round(Math.max(0, Math.min(100, c.battery)) * 0.2);
    const color = isLow(c) ? '#ED18BF' : '#1B9EFA';
    return `<svg width="16" height="28" viewBox="0 0 16 28" fill="none"><path fill-rule="evenodd" clip-rule="evenodd" d="M11 0H5V2H0V28H16V2H11V0ZM1.5 3.5H14.5V26.5H1.5V3.5Z" fill="white"/>` +
      `<rect x="3" y="${5 + 20 - h}" width="10" height="${h}" fill="${color}"/>` +
      (c.charging ? '<path transform="translate(4.5 10)" d="M0 6.25L3.5 0V3.75H7L3.5 10V6.25H0Z" fill="white"/>' : '') + '</svg>';
  }
  const HD_MIC_HELP = "Provides significantly better audio and microphone quality than Bluetooth Hands-Free (headset) mode. However, audio playback quality is still noticeably lower than in regular headphone mode.\n\nWhen enabled, the \"MagicPods Virtual Mic\" audio input device is automatically created and selected. When disabled, audio transmission stops and the device is removed.\n\nIf the microphone isn't working, make sure \"MagicPods Virtual Mic\" is selected as the audio input device.\n\nDisable \"Conversation Awareness\" in your headphones' settings to prevent the volume from automatically decreasing while using the microphone.";
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  // ---------- styles ----------
  const STYLE_ID = 'magicpods-menu-style';
  const CSS = `
  #magicpods-overlay { position:absolute; left:0; right:0; top:0; z-index:50; background:rgb(14,20,27); color:#dcdedf;
    font-family:"Motiva Sans",Arial,Helvetica,sans-serif; font-size:14px; overflow-y:auto; overflow-x:hidden; display:none; box-sizing:border-box; padding:0 0 12px; }
  #magicpods-overlay.mp-open { display:block; }
  .mp-tabs { position:sticky; top:0; z-index:2; display:flex; gap:4px; padding:8px 10px; background:rgb(14,20,27); }
  .mp-tabs button { flex:1; height:30px; border:0; border-radius:3px; background:#23262e; color:#b8bcbf; font:inherit; font-size:12px; cursor:pointer; }
  .mp-tabs button.mp-on { background:#1a9fff; color:#fff; }
  .mp-sec { padding:6px 14px 2px; }
  .mp-title { font-size:15px; font-weight:700; color:#fff; margin:6px 0 8px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .mp-h { font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:#8b929a; margin:14px 0 6px; }
  .mp-msg { color:#b8bcbf; padding:12px 14px; line-height:1.35; }
  .mp-banner { margin:8px 10px; padding:8px 10px; border-radius:3px; background:#3d2a1a; color:#ffcf99; display:flex; align-items:center; gap:8px; }
  .mp-banner button, .mp-btn { border:0; border-radius:3px; background:#3d4450; color:#fff; font:inherit; font-size:12px; padding:6px 10px; cursor:pointer; }
  .mp-bats { display:flex; justify-content:space-around; margin:4px 0 10px; }
  .mp-bat { display:flex; flex-direction:column; align-items:center; gap:3px; font-size:11px; color:#8b929a; }
  .mp-bat b { font-size:18px; color:#fff; }
  .mp-modes { display:grid; grid-template-columns:repeat(auto-fit,minmax(64px,1fr)); gap:4px; margin-bottom:6px; }
  .mp-mode { display:flex; flex-direction:column; align-items:center; gap:2px; padding:6px 2px; border:0; border-radius:3px; background:#23262e; color:#b8bcbf; font:inherit; font-size:10px; cursor:pointer; }
  .mp-mode.mp-on { background:#1a9fff; color:#fff; }
  .mp-row { display:flex; align-items:center; justify-content:space-between; gap:10px; min-height:38px; border-bottom:1px solid #23262e; }
  .mp-row > span { flex:1; line-height:1.25; }
  .mp-row.mp-col { flex-direction:column; align-items:stretch; justify-content:center; padding:6px 0; gap:4px; }
  .mp-row.mp-dis { opacity:.45; pointer-events:none; }
  .mp-sw { position:relative; width:44px; height:24px; flex:none; border-radius:12px; background:#3d4450; border:0; cursor:pointer; }
  .mp-sw::after { content:""; position:absolute; top:3px; left:3px; width:18px; height:18px; border-radius:50%; background:#dcdedf; transition:left .12s; }
  .mp-sw.mp-on { background:#1a9fff; } .mp-sw.mp-on::after { left:23px; background:#fff; }
  .mp-range { display:flex; align-items:center; gap:8px; }
  .mp-range input { flex:1; accent-color:#1a9fff; height:24px; }
  .mp-range output { min-width:40px; text-align:right; color:#fff; }
  .mp-ticks { display:flex; justify-content:space-between; font-size:10px; color:#8b929a; }
  .mp-choice { display:flex; flex-wrap:wrap; gap:4px; }
  .mp-choice button { border:0; border-radius:3px; background:#23262e; color:#b8bcbf; font:inherit; font-size:12px; padding:6px 8px; cursor:pointer; }
  .mp-choice button.mp-on { background:#1a9fff; color:#fff; }
  .mp-note { font-size:11px; color:#8b929a; line-height:1.3; }
  .mp-dev { display:flex; align-items:center; gap:8px; }
  .mp-info { flex:none; width:22px; height:22px; border-radius:50%; border:1px solid #8b929a; background:transparent; color:#b8bcbf; font:inherit; font-size:12px; font-weight:700; cursor:pointer; padding:0; margin-right:8px; }
  .mp-info.mp-on { background:#1a9fff; border-color:#1a9fff; color:#fff; }
  .mp-infotext { font-size:12px; color:#b8bcbf; line-height:1.35; white-space:pre-line; padding:4px 0 8px; border-bottom:1px solid #23262e; }
  .mp-infotext table { width:100%; border-collapse:collapse; } .mp-infotext td { padding:3px 4px; vertical-align:top; border-top:1px solid #23262e; } .mp-infotext td:first-child { color:#fff; white-space:nowrap; }
  #magicpods-battery-row { display:flex; align-items:center; gap:10px; padding:10px 16px; cursor:pointer; color:#dcdedf; border-top:1px solid #23262e; }
  #magicpods-battery-row .mp-name { flex:1; font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #magicpods-battery-row .mp-cells { display:flex; gap:10px; font-size:12px; }
  `;
  function ensureStyle() {
    const old = document.getElementById(STYLE_ID);
    if (old && old.dataset.mpVersion === VERSION) return;
    if (old) old.remove();
    const s = document.createElement('style');
    s.id = STYLE_ID; s.textContent = CSS; s.dataset.mpVersion = VERSION;
    (document.head || document.documentElement).appendChild(s);
  }
  cleanups.push(() => { const s = document.getElementById(STYLE_ID); if (s) s.remove(); });

  // ---------- small DOM builders (all values escaped) ----------
  let pendingDevice = null;   // { address, target } while a connect/disconnect is in flight
  let pendingTimer = null;
  const holdDraft = { server: null, value: 0 };  // press-and-hold noise modes being edited
  function clearPending() { pendingDevice = null; clearTimeout(pendingTimer); pendingTimer = null; }
  let interacting = false;    // pointer down inside the menu: hold re-renders
  let renderQueued = false;
  const infoOpen = {};  // which (i) explanations are expanded
  function infoButton(key) {
    return `<button class="mp-info${infoOpen[key] ? ' mp-on' : ''}" aria-label="More information" data-mp="${on(() => { infoOpen[key] = !infoOpen[key]; render(); })}">i</button>`;
  }
  function infoBlock(key, html) {
    return infoOpen[key] ? `<div class="mp-infotext">${html}</div>` : '';
  }
  const handlers = new Map(); // id -> function(event, element)
  let hid = 0;
  const on = (fn) => { const id = 'h' + (++hid); handlers.set(id, fn); return id; };

  function toggleRow(label, checked, fn, opts = {}) {
    return `<div class="mp-row${opts.disabled ? ' mp-dis' : ''}"><span>${esc(label)}${opts.note ? `<div class="mp-note">${esc(opts.note)}</div>` : ''}</span>` +
      (opts.info ? infoButton(opts.info.key) : '') +
      `<button class="mp-sw${checked ? ' mp-on' : ''}" data-mp="${on(() => fn(!checked))}" aria-pressed="${checked ? 'true' : 'false'}"></button></div>` +
      (opts.info ? infoBlock(opts.info.key, esc(opts.info.text)) : '');
  }
  function sliderRow(label, o, fn) {
    const id = on((ev, el) => {
      const v = Number(el.value);
      const out = el.parentElement.querySelector('output');
      if (out) out.textContent = fmt(v);
      if (ev.type === 'change' || ev.type === 'input') debounced(label, () => fn(v));
    });
    const fmt = (v) => o.labels && o.labels[v] != null ? o.labels[v] : (o.unit === '%' ? (v === 0 && o.offAtZero ? 'Off' : v + '%') : String(v));
    const ticks = o.ticks ? `<div class="mp-ticks">${o.ticks.map((t) => `<span>${esc(t)}</span>`).join('')}</div>` : '';
    return `<div class="mp-row mp-col${o.disabled ? ' mp-dis' : ''}"><span>${esc(label)}</span><div class="mp-range">` +
      `<input type="range" min="${o.min}" max="${o.max}" step="${o.step || 1}" value="${Number(o.value)}" data-mp="${id}">` +
      `<output>${esc(fmt(Number(o.value)))}</output></div>${ticks}</div>`;
  }
  function choiceRow(label, options, value, fn, opts = {}) {
    const head = opts.info ? `<div class="mp-dev"><span style="flex:1">${esc(label)}</span>${infoButton(opts.info.key)}</div>` : `<span>${esc(label)}</span>`;
    return `<div class="mp-row mp-col${opts.disabled ? ' mp-dis' : ''}">${head}${opts.info ? infoBlock(opts.info.key, opts.info.html) : ''}<div class="mp-choice">` +
      options.map((o) => `<button class="${o.value === value ? 'mp-on' : ''}" data-mp="${on(() => fn(o.value))}">${esc(o.label)}</button>`).join('') +
      `</div>${opts.note ? `<div class="mp-note">${esc(opts.note)}</div>` : ''}</div>`;
  }

  // ---------- pages ----------
  function pageDevice() {
    if (core.badVersion) return `<div class="mp-msg">Please update MagicPods to continue.</div>`;
    if (!core.ready) return '';
    const info = core.info;
    if (!info) return `<div class="mp-msg">Connect headphones to display their battery level and adjust settings.</div>`;
    const caps = info.capabilities || {};
    let h = `<div class="mp-sec"><div class="mp-title">${esc(info.name || 'Headphones')}</div>`;
    const b = buds();
    if (b) h += `<div class="mp-bats">${b.map((c) => `<div class="mp-bat" style="opacity:${c.status === 3 ? .5 : 1}">${esc(c.label)}${batteryIcon(c)}<b>${c.battery}%</b></div>`).join('')}</div>`;

    if (caps.anc) {
      const allowed = ANC_MODES.filter((m) => (caps.anc.options & m.bit) && settings['allow_' + m.key]);
      if (ANC_MODES.filter((m) => settings['allow_' + m.key]).length >= 2 && allowed.length) {
        h += `<div class="mp-h">Noise control</div><div class="mp-modes">` + allowed.map((m) =>
          `<button class="mp-mode${caps.anc.selected === m.bit ? ' mp-on' : ''}" data-mp="${on(() => { if (!caps.anc.readonly) setCapability('anc', m.bit); })}">${svgPath(m.path)}<span>${esc(m.label)}</span></button>`).join('') + `</div>`;
      }
    }
    if (caps.highResolutionMicrophone) {
      const c = caps.highResolutionMicrophone;
      h += toggleRow('HD Microphone', !!c.selected, (v) => setCapability('highResolutionMicrophone', v), { disabled: c.readonly, info: { key: 'hdmic', text: HD_MIC_HELP } });
    }

    let o = '';
    const ro = (k) => !!(caps[k] && caps[k].readonly);
    if (caps.bluetoothCodec && Array.isArray(caps.bluetoothCodec.options)) {
      const c = caps.bluetoothCodec;
      const table = '<table><tr><td>Codec</td><td>Description</td></tr>' + c.options.map((x) => `<tr><td>${esc(x[0])}</td><td>${esc(x[1])}</td></tr>`).join('') + '</table>';
      o += choiceRow('Bluetooth codec', c.options.map((x) => ({ value: x[0], label: x[0] })), c.selected, (v) => setCapability('bluetoothCodec', v), { info: { key: 'codec', html: table } });
    }
    if (caps.earDetection) {
      const s = caps.earDetection.selected || {};
      const send = (patch) => { const c = live('earDetection'); setCapability('earDetection', Object.assign({ pauseMedia: !!c.pauseMedia, switchToSpeakers: !!c.switchToSpeakers, lowerVolume: c.lowerVolume | 0 }, patch)); };
      o += toggleRow('Pause when off-ear', !!s.pauseMedia, (v) => send({ pauseMedia: v }), { disabled: ro('earDetection') });
      o += sliderRow('Lower volume when off-ear', { min: 0, max: 100, value: s.lowerVolume | 0, unit: '%', offAtZero: true, disabled: ro('earDetection') }, (v) => send({ lowerVolume: v }));
      o += toggleRow('Switch to speaker when fully removed', !!s.switchToSpeakers, (v) => send({ switchToSpeakers: v }), { disabled: ro('earDetection') });
    }
    if (caps.conversationAwareness) {
      const s = caps.conversationAwareness.selected || {};
      const send = (patch) => { const c = live('conversationAwareness'); setCapability('conversationAwareness', Object.assign({ enabled: !!c.enabled, volume: c.volume | 0 }, patch)); };
      o += toggleRow('Conversation awareness', !!s.enabled, (v) => send({ enabled: v }), { disabled: ro('conversationAwareness') });
      o += sliderRow('Lower volume when talking', { min: 0, max: 100, value: s.volume | 0, unit: '%', offAtZero: true, disabled: ro('conversationAwareness') || !s.enabled }, (v) => send({ volume: v }));
    }
    if (caps.personalizedVolume) o += toggleRow('Personalized volume', !!caps.personalizedVolume.selected, (v) => setCapability('personalizedVolume', v), { disabled: ro('personalizedVolume') });
    if (caps.digitalCrown) o += choiceRow('Digital Crown', [{ value: -1, label: "Don't Change" }, { value: 1, label: 'Back to front' }, { value: 2, label: 'Front to back' }], caps.digitalCrown.selected, (v) => setCapability('digitalCrown', v), { disabled: ro('digitalCrown') });
    if (caps.pressAndHoldAirPodMode) {
      const c = caps.pressAndHoldAirPodMode, s = c.selected || {};
      const names = { 1: 'Voice assistant', 5: 'Noise control', 7: 'Volume down', 6: 'Volume up' };
      const opts = [1, 5, 7, 6].filter((v) => !Array.isArray(c.options) || c.options.includes(v)).map((v) => ({ value: v, label: names[v] }));
      o += choiceRow('Left press and hold', opts, s.left, (v) => setCapability('pressAndHoldAirPodMode', { left: v }), { disabled: ro('pressAndHoldAirPodMode') });
      o += choiceRow('Right press and hold', opts, s.right, (v) => setCapability('pressAndHoldAirPodMode', { right: v }), { disabled: ro('pressAndHoldAirPodMode') });
    }
    if (caps.pressAndHoldAirPodModeAnc) {
      const c = caps.pressAndHoldAirPodModeAnc;
      const avail = HOLD_MODES.filter((m) => (c.options | 0) & m.bit);
      const server = c.selected === -1 ? 0 : ((c.selected | 0) & (c.options | 0));
      if (holdDraft.server !== server) { holdDraft.server = server; holdDraft.value = server; }
      const draft = holdDraft.value;
      const count = [1, 2, 4, 8].filter((x) => draft & x).length;
      o += `<div class="mp-row mp-col${c.readonly ? ' mp-dis' : ''}"><span>Noise control from headphones</span><div class="mp-choice">` +
        avail.map((m) => {
          const mode = ANC_MODES.find((x) => x.key === m.key);
          return `<button class="${draft & m.bit ? 'mp-on' : ''}" data-mp="${on(() => { holdDraft.value = draft ^ m.bit; render(); })}">${esc(mode ? mode.label : m.key)}</button>`;
        }).join('') + `</div>`;
      if (draft !== server) {
        o += `<div class="mp-choice"><button class="mp-on" ${count === 1 ? 'disabled style="opacity:.4"' : ''} data-mp="${on(() => {
          if ([1, 2, 4, 8].filter((x) => holdDraft.value & x).length === 1) return;
          setCapability('pressAndHoldAirPodModeAnc', holdDraft.value || -1);
        })}">Apply</button><button data-mp="${on(() => { holdDraft.value = server; render(); })}">Cancel</button></div>`;
      }
      o += `<div class="mp-note">${draft ? '' : "Don't change. "}Select at least two modes, or clear all to leave the setting unchanged.</div></div>`;
    }
    if (caps.adaptiveAudioNoise) o += sliderRow('Adaptive mode', { min: 0, max: 100, step: 50, value: caps.adaptiveAudioNoise.selected | 0, labels: { 0: 'More noise', 50: 'Default', 100: 'Less noise' }, ticks: ['More noise', 'Default', 'Less noise'], disabled: ro('adaptiveAudioNoise') }, (v) => setCapability('adaptiveAudioNoise', v));
    if (caps.ancOneAirPod) o += toggleRow('Noise cancellation with one earbud', !!caps.ancOneAirPod.selected, (v) => setCapability('ancOneAirPod', v), { disabled: ro('ancOneAirPod') });
    if (caps.ancOffMode) o += choiceRow('Off Listening Mode', [{ value: -1, label: "Don't Change" }, { value: 1, label: 'Enabled' }, { value: 2, label: 'Disabled' }], caps.ancOffMode.selected, (v) => setCapability('ancOffMode', v), { disabled: ro('ancOffMode') });
    if (caps.customEq) {
      const s = caps.customEq.selected || {};
      const send = (patch) => { const c = live('customEq'); setCapability('customEq', Object.assign({ enabled: !!c.enabled, low: c.low | 0, mid: c.mid | 0, high: c.high | 0 }, patch)); };
      const off = ro('customEq') || !s.enabled;
      o += toggleRow('Equalizer', !!s.enabled, (v) => send({ enabled: v }), { disabled: ro('customEq') });
      for (const [k, name] of [['low', 'Low'], ['mid', 'Mid'], ['high', 'High']]) {
        o += sliderRow('Equalizer: ' + name, { min: 0, max: 100, value: s[k] | 0, unit: '%', ticks: ['0', '50', '100'], disabled: off }, (v) => send({ [k]: v }));
      }
    }
    const steps = (key, label, names) => {
      if (caps[key]) o += sliderRow(label, { min: 0, max: 2, value: caps[key].selected | 0, labels: names, ticks: [names[0], names[1], names[2]], disabled: ro(key) }, (v) => setCapability(key, v));
    };
    steps('pressSpeed', 'Press speed', { 0: 'Default', 1: 'Slower', 2: 'Slowest' });
    steps('pressAndHoldDuration', 'Press and hold duration', { 0: 'Default', 1: 'Shorter', 2: 'Shortest' });
    if (caps.volumeSwipe) o += toggleRow('Volume swipe', !!caps.volumeSwipe.selected, (v) => setCapability('volumeSwipe', v), { disabled: ro('volumeSwipe') });
    steps('volumeSwipeLength', 'Swipe length', { 0: 'Default', 1: 'Longer', 2: 'Longest' });
    if (caps.endCall) {
      o += choiceRow('End call', [{ value: 2, label: 'Press twice' }, { value: 3, label: 'Press once' }], caps.endCall.selected, (v) => setCapability('endCall', v),
        { disabled: ro('endCall'), note: 'Mute and unmute: ' + (caps.endCall.selected === 2 ? 'Press once' : 'Press twice') });
    }
    if (caps.toneVolume) o += sliderRow('Tone volume', { min: 15, max: 125, value: caps.toneVolume.selected | 0, unit: '%', ticks: ['15', '125'], disabled: ro('toneVolume') }, (v) => setCapability('toneVolume', v));
    if (caps.sleepDetection) o += toggleRow('Pause When Asleep', !!caps.sleepDetection.selected, (v) => setCapability('sleepDetection', v), { disabled: ro('sleepDetection') });
    if (caps.optimizedCharge) o += toggleRow('Optimized Charge Limit', !!caps.optimizedCharge.selected, (v) => setCapability('optimizedCharge', v), { disabled: ro('optimizedCharge') });
    if (o) h += `<div class="mp-h">Options</div>` + o +
      `<div class="mp-note" style="margin-top:6px">Certain options may appear even if your headphones do not support them.</div>`;
    return h + '</div>';
  }

  function pageHeadphones() {
    if (!core.ready) return '';
    let h = '<div class="mp-sec">';
    if (core.bluetooth) {
      h += `<div class="mp-h">Bluetooth</div>` + toggleRow('Bluetooth', !!core.bluetooth.enabled, (v) => {
        core.bluetooth = { enabled: v }; coreSend(v ? 'EnableDefaultBluetoothAdapter' : 'DisableDefaultBluetoothAdapter'); render();
      });
    }
    const list = (core.headphones || []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
    if (list.length) {
      h += `<div class="mp-h">Headphones</div>` + list.map((d) => {
        const pending = pendingDevice && pendingDevice.address === d.address;
        return toggleRow(d.name, pending ? pendingDevice.target : !!d.connected, (v) => {
          clearPending();
          pendingDevice = { address: d.address, target: v };
          coreSend(v ? 'ConnectDevice' : 'DisconnectDevice', { address: d.address });
          pendingTimer = setTimeout(() => { clearPending(); coreSend('GetDevices'); render(); }, 15000);
          render();
        }, { disabled: pending, note: pending ? (pendingDevice.target ? 'Connecting...' : 'Disconnecting...') : '' });
      }).join('');
    } else {
      h += `<div class="mp-msg">No paired headphones. Pair them in Steam's Bluetooth settings.</div>`;
    }
    return h + '</div>';
  }

  // Update status, written by the helper service as JSON text: {state, message, time}.
  function updateStatus() {
    let st = null;
    try { st = JSON.parse(core.frameSettings.update_status || 'null'); } catch (e) { st = null; }
    if (!st || typeof st !== 'object' || typeof st.message !== 'string') return null;
    const inProgress = st.state === 'checking' || st.state === 'updating';
    const busy = inProgress && Number(st.time) > Date.now() / 1000 - (st.state === 'checking' ? 90 : 900);
    const message = inProgress && !busy ? 'The last update check did not finish. Try again.' : st.message;
    return { busy, message, time: Number(st.time) || 0 };
  }
  function whenText(t) {
    if (!t) return '';
    const d = new Date(t * 1000);
    const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toDateString() === new Date().toDateString() ? 'today ' + hm : d.toLocaleDateString() + ' ' + hm;
  }
  function pageUpdates() {
    const auto = core.frameSettings.auto_update !== false;
    const st = updateStatus();
    let h = `<div class="mp-h">Updates</div>` + toggleRow('Update automatically', auto, (v) => {
      core.frameSettings.auto_update = v; coreSend('SetSetting', { container: 'magicpodsframe', setting: 'auto_update', value: v }); render();
    }, { note: 'Checks for a new MagicPods every few hours and installs it.' });
    const label = st && st.busy ? st.message : 'Check for updates';
    h += `<div class="mp-row mp-col${st && st.busy ? ' mp-dis' : ''}"><div class="mp-choice"><button data-mp="${on(() => {
      if (st && st.busy) return;
      const n = Math.max(Math.floor(Date.now() / 1000), (Number(core.frameSettings.update_request) || 0) + 1);
      if (!coreSend('SetSetting', { container: 'magicpodsframe', setting: 'update_request', value: n })) return;
      core.frameSettings.update_request = n;
      core.frameSettings.update_status = JSON.stringify({ state: 'checking', message: 'Checking for updates...', time: Math.floor(Date.now() / 1000) });
      render();
    })}">${esc(label)}</button></div>` +
      (st && !st.busy ? `<div class="mp-note">${esc(st.message)}${st.time ? ' (' + esc(whenText(st.time)) + ')' : ''}</div>` : '') + `</div>`;
    return h;
  }

  function pageSettings() {
    let h = '<div class="mp-sec"><div class="mp-h">Displayed modes</div>';
    for (const m of ANC_MODES) h += toggleRow(m.label, !!settings['allow_' + m.key], (v) => saveSettings({ ['allow_' + m.key]: v }));
    h += `<div class="mp-h">Menu</div>` +
      toggleRow('Auto-select tab', !!settings.auto_tab, (v) => saveSettings({ auto_tab: v }), { note: 'When opening the menu, show Devices if no headphones are connected.' }) +
      choiceRow('Clicking the battery icon', [{ value: 'menu', label: 'Opens this menu' }, { value: 'cycle', label: 'Cycles noise control' }], settings.click_action, (v) => saveSettings({ click_action: v }),
        { note: 'With "Cycles noise control", open the menu from the MagicPods tab or Battery Info.' });
    h += `<div class="mp-h">Battery</div>` + sliderRow('Low battery notification', { min: 0, max: 100, value: lowThreshold(), unit: '%', offAtZero: true }, (v) => {
        core.frameSettings.low_battery = v; coreSend('SetSetting', { container: 'magicpodsframe', setting: 'low_battery', value: v }); render();
      });
    if (core.ready) {
      const standby = core.frameSettings.standby_fix === true;
      h += `<div class="mp-h">Headphones</div>` + toggleRow('Disable headphone standby mode', standby, (v) => {
        core.frameSettings.standby_fix = v; coreSend('SetSetting', { container: 'magicpodsframe', setting: 'standby_fix', value: v }); render();
      }, { note: 'Fixes endless connect/disconnect of headphones by keeping the link awake with inaudible silence. Uses a little more battery while on.' });
      const anim = core.coreSettings.animation;
      if (typeof anim === 'boolean') {
        h += `<div class="mp-h">Core</div>` + toggleRow('Headphones animation', anim, (v) => {
          core.coreSettings.animation = v; coreSend('SetSetting', { container: 'magicpods', setting: 'animation', value: v }); render();
        }, { note: 'Desktop app only. Keeps Bluetooth scanning on while enabled.' });
      }
      const lvl = core.coreSettings.logLevel;
      if (typeof lvl === 'number') {
        h += sliderRow('Core log level', { min: 0, max: 50, step: 10, value: 50 - lvl, labels: { 0: 'Off', 10: 'Err', 20: 'Wrn', 30: 'Inf', 40: 'Dbg', 50: 'TRC' }, ticks: ['Off', 'Err', 'Wrn', 'Inf', 'Dbg', 'TRC'] }, (v) => {
          core.coreSettings.logLevel = 50 - v; coreSend('SetSetting', { container: 'magicpods', setting: 'logLevel', value: 50 - v });
        });
      }
      h += pageUpdates();
      h += `<div class="mp-note" style="margin-top:10px">MagicPodsCore ${esc(core.version || '')}</div>`;
    }
    return h + '</div>';
  }

  // ---------- popup: MagicPods tab ----------
  const TAB_ID = 'magicpods-qam-tab';
  const OVERLAY_ID = 'magicpods-overlay';
  let menuOpen = false;
  let releaseTimer = null;
  const tabStyles = new Map();  // native tab -> original inline width/minWidth/flex
  let stripListener = null, listenedStrip = null;
  let wantOpenUntil = 0;

  function popupParts() {
    const panel = document.querySelector('[role="tabpanel"]');
    if (!panel) return null;
    const labelled = panel.getAttribute('aria-labelledby');
    let tab = labelled && document.getElementById(labelled);
    if (!tab) tab = document.querySelector('[aria-label="Battery Info"],[aria-label="Quick Settings"]');
    const strip = tab && tab.parentElement;
    if (!strip || strip.children.length < 2) return null;
    const stripWrap = strip.parentElement;
    const root = stripWrap && stripWrap.parentElement;
    if (!root) return null;
    const content = [...root.children].find((c) => c !== stripWrap && c.contains(panel));
    if (!content) return null;
    return { panel, strip, stripWrap, root, content };
  }
  function activeClasses(strip) {
    const tabs = [...strip.children].filter((t) => t.id !== TAB_ID);
    const lists = tabs.map((t) => new Set(t.classList));
    const common = [...lists[0]].filter((c) => lists.every((l) => l.has(c)));
    const active = tabs.find((t) => t.classList.length > common.length + 0 && [...t.classList].some((c) => !common.includes(c) && !/^gpfocus/.test(c)));
    const extra = active ? [...active.classList].filter((c) => !common.includes(c) && !/^gpfocus/.test(c)) : [];
    return { common, extra, active };
  }
  let lastPresent = null;
  function reportPresence(present) {
    if (present === lastPresent) return;
    lastPresent = present;
    channel.postMessage({ type: 'popup-visible', visible: present });
  }
  function ensurePopup() {
    const p = popupParts();
    reportPresence(!!p);
    if (!p) { menuOpen = false; return; }  // popup closed: next open shows Steam's own tab
    ensureStyle();
    const { strip, stripWrap, root, content, panel } = p;
    let tab = document.getElementById(TAB_ID);
    if (!tab || tab.parentElement !== strip || tab.dataset.mpVersion !== VERSION) {
      if (tab) tab.remove();
      const { common } = activeClasses(strip);
      tab = document.createElement('div');
      tab.id = TAB_ID;
      tab.dataset.mpVersion = VERSION;
      tab.className = common.join(' ');
      tab.setAttribute('aria-label', 'MagicPods');
      tab.setAttribute('role', 'button');
      tab.innerHTML = EARBUDS_ICON.replace('width="20" height="20"', 'width="26" height="26"');
      tab.style.display = 'flex'; tab.style.alignItems = 'center'; tab.style.justifyContent = 'center'; tab.style.color = 'currentColor';
      tab.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); setMenuOpen(true); });
      strip.appendChild(tab);
    }
    const n = strip.children.length;
    for (const t of strip.children) {
      if (t.id !== TAB_ID && !tabStyles.has(t)) tabStyles.set(t, { width: t.style.width, minWidth: t.style.minWidth, flex: t.style.flex });
      t.style.width = (100 / n) + '%'; t.style.minWidth = '0'; t.style.flex = '1 1 0';
    }
    if (listenedStrip !== strip) {
      if (listenedStrip && stripListener) listenedStrip.removeEventListener('click', stripListener, true);
      stripListener = (ev) => {
        const t = document.getElementById(TAB_ID);
        if (t && t.contains(ev.target)) return;
        const clicked = [...strip.children].find((c) => c.contains(ev.target));
        setMenuOpen(false, clicked);
      };
      strip.addEventListener('click', stripListener, true);
      listenedStrip = strip;
    }
    let overlay = document.getElementById(OVERLAY_ID);
    if (!overlay || overlay.parentElement !== root || overlay.dataset.mpVersion !== VERSION) {
      if (overlay) overlay.remove();
      overlay = document.createElement('div');
      overlay.id = OVERLAY_ID;
      overlay.dataset.mpVersion = VERSION;
      overlay.addEventListener('click', onMenuEvent);
      overlay.addEventListener('input', onMenuEvent);
      overlay.addEventListener('change', onMenuEvent);
      const release = () => { clearTimeout(releaseTimer); interacting = false; if (renderQueued) { renderQueued = false; render(); } };
      overlay.addEventListener('pointerdown', () => { interacting = true; clearTimeout(releaseTimer); releaseTimer = setTimeout(release, 5000); }, true);
      overlay.addEventListener('pointerup', () => { clearTimeout(releaseTimer); releaseTimer = setTimeout(release, 400); }, true);
      overlay.addEventListener('pointercancel', release, true);
      if (getComputedStyle(root).position === 'static') root.style.position = 'relative';
      root.appendChild(overlay);
    }
    overlay.style.height = Math.max(0, root.clientHeight - stripWrap.offsetHeight) + 'px';
    if (wantOpenUntil > Date.now()) { wantOpenUntil = 0; setMenuOpen(true); }
    applyTabState(p);
    ensureBatteryRow(panel);
  }
  function applyTabState(p, clicked) {
    const parts = p || popupParts();
    if (!parts) return;
    const overlay = document.getElementById(OVERLAY_ID);
    const tab = document.getElementById(TAB_ID);
    if (!overlay || !tab) return;
    overlay.classList.toggle('mp-open', menuOpen);
    const { extra, active } = activeClasses(parts.strip);
    if (menuOpen) {
      if (active && extra.length) { parts.strip.__mpNativeActive = active; parts.strip.__mpExtra = extra; active.classList.remove(...extra); }
      if (parts.strip.__mpExtra) tab.classList.add(...parts.strip.__mpExtra);
    } else {
      if (parts.strip.__mpExtra) tab.classList.remove(...parts.strip.__mpExtra);
      const native = parts.strip.__mpNativeActive;
      // React re-highlights a newly clicked tab itself; restore only the previous one.
      if (native && native.isConnected && parts.strip.__mpExtra && (!clicked || clicked === native)) native.classList.add(...parts.strip.__mpExtra);
      parts.strip.__mpNativeActive = null;
    }
  }
  function setMenuOpen(open, clicked) {
    if (menuOpen === open) { applyTabState(); return; }
    menuOpen = open;
    applyTabState(null, clicked);
    if (open) {
      if (settings.auto_tab && core.ready) {
        const want = core.info ? (settings.tab === 'headphones' ? 'device' : settings.tab) : 'headphones';
        if (want !== settings.tab) settings = Object.assign({}, settings, { tab: want });
      }
      const ov = document.getElementById(OVERLAY_ID); if (ov) ov.scrollTop = 0; render();
    }
  }
  function onMenuEvent(ev) {
    const el = ev.target.closest('[data-mp]');
    if (!el) return;
    const fn = handlers.get(el.getAttribute('data-mp'));
    if (!fn) return;
    if (el.tagName === 'INPUT') { fn(ev, el); return; }
    if (ev.type !== 'click') return;
    ev.preventDefault(); ev.stopPropagation();
    interacting = false; renderQueued = false;
    fn(ev, el);
  }
  function ensureBatteryRow(panel) {
    let row = document.getElementById('magicpods-battery-row');
    const isBatteryTab = panel && /tab_VRBatteries/.test(panel.className);
    const b = buds();
    if (!isBatteryTab || !b || !core.info) { if (row) row.remove(); return; }
    if (!row || row.parentElement !== panel || row.dataset.mpVersion !== VERSION) {
      if (row) row.remove();
      row = document.createElement('div');
      row.id = 'magicpods-battery-row';
      row.dataset.mpVersion = VERSION;
      row.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); setMenuOpen(true); });
      panel.appendChild(row);
    }
    const pods = b.filter((c) => c.key !== 'case');
    const html = `${pods.length ? headerBatteryIcon(pods) : EARBUDS_ICON}<span class="mp-name">${esc(core.info.name || 'Headphones')}</span><span class="mp-cells">` +
      b.map((c) => `<span style="opacity:${c.status === 3 ? .5 : 1};${isLow(c) ? 'color:#ED18BF' : ''}">${esc(c.label[0])} ${c.battery}%${c.charging ? '+' : ''}</span>`).join('') + '</span>';
    if (row.__mpHtml !== html) { row.innerHTML = html; row.__mpHtml = html; }
  }

  function renderMenu() {
    const overlay = document.getElementById(OVERLAY_ID);
    if (!overlay || !menuOpen) return;
    handlers.clear(); hid = 0;
    const tabs = [['device', 'Headphones'], ['headphones', 'Devices'], ['settings', 'Settings']];
    let h = `<div class="mp-tabs">` + tabs.map(([k, label]) =>
      `<button class="${settings.tab === k ? 'mp-on' : ''}" data-mp="${on(() => saveSettings({ tab: k }))}">${label}</button>`).join('') + `</div>`;
    if (!core.ready && !core.badVersion) {
      h += `<div class="mp-banner"><span>MagicPods service is not reachable.</span><button data-mp="${on(() => { clearTimeout(core.timer); coreConnect(); })}">Retry</button></div>`;
    }
    h += settings.tab === 'headphones' ? pageHeadphones() : settings.tab === 'settings' ? pageSettings() : pageDevice();
    const top = overlay.scrollTop;
    overlay.innerHTML = h;
    overlay.scrollTop = top;
  }

  // Next allowed noise mode after the current one (wraps); null if fewer than two.
  function nextAncMode() {
    const anc = core.info && core.info.capabilities && core.info.capabilities.anc;
    if (!anc || anc.readonly) return null;
    const modes = ANC_MODES.filter((m) => (anc.options & m.bit) && settings['allow_' + m.key]).map((m) => m.bit);
    if (modes.length < 2) return null;
    return modes.find((b) => b > anc.selected) || modes[0];
  }

  // ---------- bar: indicator ----------
  const IND_ID = 'magicpods-bar-indicator';
  let popupVisible = false;
  function ensureBar() {
    const anchor = document.querySelector('[aria-label^="Headset Battery"]');
    if (!anchor || !anchor.parentElement) return;
    let el = document.getElementById(IND_ID);
    if (!el || el.parentElement !== anchor.parentElement || el.dataset.mpVersion !== VERSION) {
      if (el) el.remove();
      el = document.createElement('div');
      el.id = IND_ID;
      el.dataset.mpVersion = VERSION;
      el.setAttribute('role', 'button');
      el.style.cssText = 'display:none;align-items:center;gap:3px;margin-right:14px;cursor:pointer;pointer-events:auto;';
      el.innerHTML = '<i class="mp-ic" style="display:flex;font-style:normal"></i><span></span>';
      el.style.alignSelf = 'center';
      el.addEventListener('click', (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        if (settings.click_action === 'cycle') {
          const next = nextAncMode();
          if (next != null) { setCapability('anc', next); return; }
        }
        channel.postMessage({ type: 'open' });
        if (!popupVisible) {
          const a = document.querySelector('[aria-label^="Headset Battery"]');
          if (a) a.click();
        }
      });
      anchor.parentElement.insertBefore(el, anchor);
    }
    const ref = anchor.querySelector('span');  // match Steam's own label (it may render after us)
    if (ref) {
      const span = el.querySelector('span');
      if (span.className !== ref.className) span.className = ref.className;
      const cs = getComputedStyle(ref);
      for (const k of ['fontSize', 'fontWeight', 'lineHeight', 'fontFamily', 'letterSpacing']) {
        if (span.style[k] !== cs[k]) span.style[k] = cs[k];
      }
    }
    const b = buds();
    const pods = b && b.filter((c) => c.key !== 'case');
    if (!pods || !pods.length) { el.style.display = 'none'; return; }
    const low = pods.reduce((m, c) => (c.battery < m.battery ? c : m));
    el.style.display = 'flex';
    const icon = headerBatteryIcon(pods);
    const ic = el.querySelector('.mp-ic');
    if (ic.__mpHtml !== icon) { ic.innerHTML = icon; ic.__mpHtml = icon; }
    el.querySelector('span').textContent = low.battery + '%';
    el.style.opacity = pods.every((c) => c.status === 3) ? '0.5' : '1';
    const title = (core.info.name || 'Headphones') + ': ' + b.map((c) => `${c.label} ${c.battery}%${c.charging ? ' charging' : ''}`).join(', ');
    el.setAttribute('aria-label', title); el.title = title;
  }
  cleanups.push(() => {
    if (ROLE === 'popup') { try { setMenuOpen(false); } catch (e) { } }
    if (listenedStrip && stripListener) listenedStrip.removeEventListener('click', stripListener, true);
    for (const [t, st] of tabStyles) { if (t.isConnected) { t.style.width = st.width; t.style.minWidth = st.minWidth; t.style.flex = st.flex; } }
    tabStyles.clear();
    clearTimeout(releaseTimer); clearPending();
  });
  cleanups.push(() => { for (const id of [IND_ID, TAB_ID, OVERLAY_ID, 'magicpods-battery-row']) { const e = document.getElementById(id); if (e) e.remove(); } });

  // ---------- wiring ----------
  function render() {
    if (dead) return;
    if (ROLE === 'bar') { ensureBar(); return; }
    if (interacting) { renderQueued = true; ensureBatteryRow(document.querySelector('[role="tabpanel"]')); return; }
    renderMenu();
    ensureBatteryRow(document.querySelector('[role="tabpanel"]'));
  }
  function ensure() {
    if (dead) return;
    try { if (ROLE === 'bar') ensureBar(); else ensurePopup(); } catch (e) { console.warn('magicpods:', e); }
  }
  channel.onmessage = (ev) => {
    const m = ev.data || {};
    if (m.type === 'open' && ROLE === 'popup') {
      wantOpenUntil = Date.now() + 3000;
      ensure();
      if (popupParts()) { wantOpenUntil = 0; setMenuOpen(true); }
    } else if (m.type === 'hello' && ROLE === 'popup') {
      lastPresent = null; ensure();
    } else if (m.type === 'popup-visible' && ROLE === 'bar') {
      popupVisible = !!m.visible;
    } else if (m.type === 'settings') {
      settings = loadSettings(); render();
    }
  };
  let scheduled = false;
  const observer = new MutationObserver((records) => {
    if (records.every((r) => r.target.id === OVERLAY_ID || (r.target.closest && r.target.closest('#' + OVERLAY_ID)))) return;
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; ensure(); });
  });
  observer.observe(document.body, { childList: true, subtree: true });
  cleanups.push(() => observer.disconnect());

  window.__magicpodsMenu = {
    version: VERSION, role: ROLE, ensure,
    teardown() { dead = true; for (const c of cleanups.reverse()) { try { c(); } catch (e) { } } delete window.__magicpodsMenu; },
  };
  coreConnect();
  ensure();
  if (ROLE === 'bar') channel.postMessage({ type: 'hello' });
  return 'installed ' + VERSION + ' (' + ROLE + ')';
  } catch (e) {
    dead = true;
    for (const c of cleanups.reverse()) { try { c(); } catch (_) { } }
    if (window.__magicpodsMenu && window.__magicpodsMenu.version === VERSION) delete window.__magicpodsMenu;
    throw e;
  }
})()
