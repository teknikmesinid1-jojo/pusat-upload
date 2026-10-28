'use strict';
(() => {
  const C = window.APP_CONFIG || {};
  const GV = C.GRAPH_VERSION || 'v24.0';
  const YT_UPLOAD = 'https://www.googleapis.com/auth/youtube.upload';
  const YT_SCOPES = YT_UPLOAD + ' https://www.googleapis.com/auth/youtube.readonly';
  const IG_SCOPES = 'instagram_basic,instagram_content_publish,pages_show_list,pages_read_engagement,pages_manage_posts,business_management';

  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fmtNum = (n) => n.toLocaleString('id-ID');

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage penuh/diblokir */ } },
    sget(k, d) { try { const v = sessionStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    sset(k, v) { try { if (v == null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* abaikan */ } },
  };

  class ApiError extends Error {
    constructor(msg, extra = {}) { super(msg); Object.assign(this, extra); }
  }

  const state = {
    file: null, kind: null, info: {}, previewUrl: null,
    yt: { client: null, token: null, exp: 0, channel: null, pending: false },
    ig: { accounts: [], selectedId: store.get('ig.selected', null) },
    busy: false,
  };

  // ---------- Umum ----------
  function setAcct(p, text, tone) {
    const el = $(p + 'Status');
    el.textContent = text;
    el.className = 'acct-status' + (tone ? ' ' + tone : '');
  }
  function showHint(text, tone) {
    const h = $('hint');
    h.hidden = !text;
    h.textContent = text || '';
    h.className = 'hint' + (tone ? ' ' + tone : '');
  }
  function baseName(name) { return name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim(); }
  function fmtSize(b) {
    if (b >= 1e9) return (b / 1e9).toLocaleString('id-ID', { maximumFractionDigits: 2 }) + ' GB';
    if (b >= 1e6) return (b / 1e6).toLocaleString('id-ID', { maximumFractionDigits: 1 }) + ' MB';
    return Math.max(1, Math.round(b / 1e3)) + ' KB';
  }
  function fmtDur(s) {
    s = Math.round(s);
    const m = Math.floor(s / 60), d = s % 60;
    return m ? m + ' menit ' + d + ' detik' : d + ' detik';
  }
  function link(href, text) {
    const a = document.createElement('a');
    a.href = href; a.target = '_blank'; a.rel = 'noopener'; a.textContent = text;
    return a;
  }

  function xhrSend(method, url, body, headers, onProgress) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open(method, url);
      Object.entries(headers || {}).forEach(([k, v]) => x.setRequestHeader(k, v));
      if (onProgress) x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      x.onload = () => {
        if (x.status >= 200 && x.status < 300) resolve(x.responseText);
        else {
          let j = {}; try { j = JSON.parse(x.responseText); } catch { /* bukan JSON */ }
          reject(new ApiError('HTTP ' + x.status, { status: x.status, body: j, text: x.responseText }));
        }
      };
      x.onerror = () => reject(new ApiError('network', { network: true }));
      x.send(body);
    });
  }

  // ---------- YouTube ----------
  function ytReady() { return !!(state.yt.token && state.yt.exp > Date.now()); }

  function initGoogle(tries = 0) {
    if (!C.GOOGLE_CLIENT_ID) { setAcct('yt', 'Belum disetel di config.js'); $('ytConnect').disabled = true; return; }
    if (!(window.google && google.accounts && google.accounts.oauth2)) {
      if (tries < 60) setTimeout(() => initGoogle(tries + 1), 200);
      else setAcct('yt', 'Login Google gagal dimuat. Muat ulang halaman.', 'bad');
      return;
    }
    state.yt.client = google.accounts.oauth2.initTokenClient({
      client_id: C.GOOGLE_CLIENT_ID,
      scope: YT_SCOPES,
      callback: onYtToken,
      error_callback: (e) => {
        state.yt.pending = false;
        setAcct('yt', e && e.type === 'popup_closed' ? 'Login dibatalkan' : 'Login Google gagal. Izinkan pop-up lalu coba lagi.', 'bad');
        showHint('');
      },
    });
    const saved = store.sget('yt.session', null);
    if (saved && saved.exp > Date.now()) {
      Object.assign(state.yt, { token: saved.token, exp: saved.exp, channel: saved.channel });
    }
    renderYt();
  }

  function onYtToken(resp) {
    if (!resp || resp.error) {
      state.yt.pending = false;
      setAcct('yt', 'Login Google gagal: ' + ((resp && resp.error) || 'tidak diketahui'), 'bad');
      return;
    }
    if (!google.accounts.oauth2.hasGrantedAllScopes(resp, YT_UPLOAD)) {
      state.yt.pending = false;
      setAcct('yt', 'Izin upload belum dicentang. Hubungkan lagi dan centang semua izin.', 'bad');
      return;
    }
    state.yt.token = resp.access_token;
    state.yt.exp = Date.now() + (Number(resp.expires_in || 3600) - 60) * 1000;
    loadYtChannel();
  }

  async function loadYtChannel() {
    setAcct('yt', 'Memuat channel…');
    try {
      const r = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
        headers: { Authorization: 'Bearer ' + state.yt.token },
      });
      const j = await r.json();
      if (!r.ok) throw new Error((j.error && j.error.message) || r.status);
      const ch = j.items && j.items[0];
      if (!ch) {
        state.yt.token = null;
        setAcct('yt', 'Akun Google ini belum punya channel YouTube.', 'bad');
        return;
      }
      state.yt.channel = { title: ch.snippet.title, thumb: ch.snippet.thumbnails && ch.snippet.thumbnails.default && ch.snippet.thumbnails.default.url };
    } catch {
      state.yt.channel = { title: 'Channel YouTube' };
    }
    store.sset('yt.session', { token: state.yt.token, exp: state.yt.exp, channel: state.yt.channel });
    renderYt();
    updateSend();
    if (state.yt.pending) { state.yt.pending = false; startUpload(); }
  }

  function renderYt() {
    const on = ytReady();
    $('acctYt').classList.toggle('on', on);
    const ch = state.yt.channel;
    $('ytName').textContent = on && ch ? ch.title : 'YouTube';
    const img = $('ytAvatar');
    if (on && ch && ch.thumb) { img.src = ch.thumb; img.hidden = false; $('ytAvatarFallback').hidden = true; }
    else { img.hidden = true; $('ytAvatarFallback').hidden = false; }
    if (C.GOOGLE_CLIENT_ID) setAcct('yt', on ? 'Terhubung' : 'Belum terhubung', on ? 'ok' : '');
    $('ytConnect').textContent = on ? 'Putuskan' : 'Hubungkan';
  }

  function toggleYt() {
    if (ytReady()) {
      try { google.accounts.oauth2.revoke(state.yt.token, () => {}); } catch { /* abaikan */ }
      Object.assign(state.yt, { token: null, exp: 0, channel: null });
      store.sset('yt.session', null);
      renderYt(); updateSend();
      return;
    }
    if (!state.yt.client) return;
    state.yt.client.requestAccessToken();
  }

  function ytError(err, status) {
    err = err || {};
    const reason = err.errors && err.errors[0] && err.errors[0].reason;
    if (status === 401) return new ApiError('Login YouTube sudah kedaluwarsa. Klik Putuskan, lalu Hubungkan lagi.');
    if (reason === 'quotaExceeded') return new ApiError('Kuota API YouTube hari ini habis. Coba lagi besok (reset jam 14.00–15.00 WIB).');
    if (reason === 'uploadLimitExceeded') return new ApiError('Channel ini sudah mencapai batas upload harian YouTube.');
    if (reason === 'youtubeSignupRequired') return new ApiError('Akun Google ini belum punya channel YouTube.');
    if (reason === 'invalidTitle') return new ApiError('Judul YouTube nggak valid. Cek panjang dan karakternya.');
    if (reason === 'invalidDescription') return new ApiError('Deskripsi YouTube nggak valid. Cek panjang dan karakternya.');
    if (reason === 'invalidPublishAt') return new ApiError('Jadwal tayang nggak valid. Pilih waktu di masa depan.');
    return new ApiError('YouTube menolak upload: ' + (err.message || 'HTTP ' + status));
  }

  async function publishYouTube(job) {
    const f = state.file;
    const title = $('ytTitle').value.trim() || baseName(f.name).slice(0, 100);
    const privacy = $('ytPrivacy').value;
    const sched = $('ytSchedule').value;
    const tags = $('ytTags').value.split(',').map((s) => s.trim()).filter(Boolean);
    const body = {
      snippet: { title, description: $('ytDesc').value, categoryId: $('ytCategory').value },
      status: { privacyStatus: privacy, selfDeclaredMadeForKids: false },
    };
    if (tags.length) body.snippet.tags = tags;
    if (sched) { body.status.privacyStatus = 'private'; body.status.publishAt = new Date(sched).toISOString(); }

    job.update(1, 'Menyiapkan upload');
    let r;
    try {
      r = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + state.yt.token,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': f.type || 'video/*',
          'X-Upload-Content-Length': String(f.size),
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new ApiError('Koneksi ke YouTube gagal. Cek internet kamu.');
    }
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw ytError(j.error, r.status); }
    const uploadUrl = r.headers.get('Location');
    if (!uploadUrl) throw new ApiError('YouTube tidak memberikan alamat upload. Coba lagi.');

    let text;
    try {
      text = await xhrSend('PUT', uploadUrl, f, { 'Content-Type': f.type || 'application/octet-stream' },
        (p) => job.update(2 + p * 96, 'Mengunggah ' + Math.round(p * 100) + '%'));
    } catch (e) {
      if (e.network) throw new ApiError('Upload ke YouTube terputus. Cek internet lalu coba lagi.');
      throw ytError(e.body && e.body.error, e.status);
    }
    const v = JSON.parse(text);
    const res = { url: 'https://youtu.be/' + v.id, extra: ['https://studio.youtube.com/video/' + v.id + '/edit', 'Buka di YouTube Studio'] };
    const got = v.status && v.status.privacyStatus;
    if (!sched && privacy !== 'private' && got === 'private') {
      res.warn = 'YouTube mengunci video ini jadi privat karena project Google kamu belum lolos audit. Setelah lolos audit, upload berikutnya bisa langsung publik.';
    } else if (sched) {
      res.info = 'Video akan tayang otomatis pada ' + new Date(sched).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }) + '.';
    }
    return res;
  }

  // ---------- Instagram (lewat Facebook Login) ----------
  function currentIg() { return state.ig.accounts.find((a) => a.igId === state.ig.selectedId) || null; }

  function initMeta() {
    if (!C.META_APP_ID) { setAcct('ig', 'Belum disetel di config.js'); $('igConnect').disabled = true; return; }
    window.fbAsyncInit = function () {
      FB.init({ appId: C.META_APP_ID, cookie: true, xfbml: false, version: GV });
      if (!store.get('ig.off', false)) {
        FB.getLoginStatus(function (r) { if (r && r.status === 'connected') onFbAuth(r.authResponse); });
      }
    };
    const s = document.createElement('script');
    s.src = 'https://connect.facebook.net/id_ID/sdk.js';
    s.async = true; s.defer = true; s.crossOrigin = 'anonymous';
    s.onerror = () => setAcct('ig', 'Login Facebook gagal dimuat. Matikan pemblokir iklan lalu muat ulang.', 'bad');
    document.head.appendChild(s);
  }

  function toggleIg() {
    if (state.ig.accounts.length) {
      state.ig.accounts = [];
      store.set('ig.off', true);
      renderIg(); updateSend();
      return;
    }
    if (!window.FB) { setAcct('ig', 'Login Facebook belum siap. Tunggu sebentar lalu coba lagi.', 'bad'); return; }
    const opts = C.META_CONFIG_ID ? { config_id: C.META_CONFIG_ID } : { scope: IG_SCOPES };
    FB.login(function (r) {
      if (r && r.authResponse) { store.set('ig.off', false); onFbAuth(r.authResponse); }
      else setAcct('ig', 'Login dibatalkan', 'bad');
    }, opts);
  }

  function onFbAuth(auth) { loadIgAccounts(auth.accessToken); }

  async function loadIgAccounts(userToken) {
    setAcct('ig', 'Mencari akun Instagram…');
    try {
      const j = await graph('me/accounts', {
        token: userToken,
        params: { fields: 'id,name,access_token,instagram_business_account{id,username,profile_picture_url}', limit: 100 },
      });
      const list = (j.data || []).filter((p) => p.instagram_business_account).map((p) => ({
        pageId: p.id, pageName: p.name, pageToken: p.access_token,
        igId: p.instagram_business_account.id,
        username: p.instagram_business_account.username,
        pic: p.instagram_business_account.profile_picture_url,
      }));
      state.ig.accounts = list;
      if (!list.length) {
        renderIg();
        setAcct('ig', 'Nggak ketemu akun Instagram Professional yang terhubung ke Facebook Page kamu.', 'bad');
        return;
      }
      if (!list.some((a) => a.igId === state.ig.selectedId)) state.ig.selectedId = list[0].igId;
      store.set('ig.selected', state.ig.selectedId);
      renderIg(); updateSend();
    } catch (e) {
      setAcct('ig', e.message, 'bad');
    }
  }

  function renderIg() {
    const a = currentIg();
    const on = !!a;
    $('acctIg').classList.toggle('on', on);
    $('igName').textContent = on ? '@' + a.username : 'Instagram';
    const img = $('igAvatar');
    if (on && a.pic) { img.src = a.pic; img.hidden = false; $('igAvatarFallback').hidden = true; }
    else { img.hidden = true; $('igAvatarFallback').hidden = false; }
    if (C.META_APP_ID) setAcct('ig', on ? 'Terhubung lewat Page ' + a.pageName : 'Belum terhubung', on ? 'ok' : '');
    $('igConnect').textContent = on ? 'Putuskan' : 'Hubungkan';
    const pick = $('igPick');
    $('igPickWrap').hidden = state.ig.accounts.length < 2;
    pick.replaceChildren(...state.ig.accounts.map((x) => {
      const o = document.createElement('option');
      o.value = x.igId; o.textContent = '@' + x.username + ' (' + x.pageName + ')';
      o.selected = x.igId === state.ig.selectedId;
      return o;
    }));
  }

  function metaError(err, status) {
    err = err || {};
    const code = err.code, sub = err.error_subcode;
    let msg = err.error_user_msg || err.message || 'HTTP ' + status;
    if (code === 190) msg = 'Login Instagram sudah kedaluwarsa. Klik Putuskan, lalu Hubungkan lagi.';
    else if (code === 10 || code === 200 || code === 3) msg = 'Izin Instagram/Facebook kurang. Hubungkan ulang dan setujui semua izin. (' + (err.message || code) + ')';
    else if (code === 4 || code === 17 || code === 32 || code === 613) msg = 'Kena batas pemakaian API Meta. Coba lagi beberapa menit lagi.';
    else if (code === 9 || sub === 2207042) msg = 'Batas posting harian Instagram tercapai. Coba lagi besok.';
    return new ApiError(msg, { code, sub, raw: err });
  }

  async function graph(path, { method = 'GET', params = {}, token } = {}) {
    const url = new URL('https://graph.facebook.com/' + GV + '/' + path);
    const p = Object.entries({ ...params, access_token: token }).map(([k, v]) => [k, String(v)]);
    const init = { method };
    if (method === 'GET') p.forEach(([k, v]) => url.searchParams.set(k, v));
    else init.body = new URLSearchParams(p);
    let r;
    try { r = await fetch(url, init); } catch { throw new ApiError('Koneksi ke Instagram/Facebook gagal. Cek internet kamu.'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw metaError(j.error, r.status);
    return j;
  }

  async function fbUploadPhoto(pageId, token, blob) {
    const fd = new FormData();
    fd.append('source', blob, 'foto.jpg');
    fd.append('published', 'false');
    fd.append('access_token', token);
    let r;
    try { r = await fetch('https://graph.facebook.com/' + GV + '/' + pageId + '/photos', { method: 'POST', body: fd }); }
    catch { throw new ApiError('Koneksi ke Facebook gagal saat mengunggah foto.'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw metaError(j.error, r.status);
    return j.id;
  }

  async function prepareImage(file, type) {
    const src = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = () => rej(new ApiError('Foto nggak bisa dibaca browser. Simpan ulang sebagai JPG lalu coba lagi.'));
        i.src = src;
      });
      const w = img.naturalWidth, h = img.naturalHeight;
      let cw = w, ch = h;
      if (type === 'feed') {
        const r = w / h;
        if (r < 0.8) cw = Math.ceil(h * 0.8);
        else if (r > 1.91) ch = Math.ceil(w / 1.91);
      }
      const scale = Math.min(1, 1440 / cw);
      const cv = document.createElement('canvas');
      cv.width = Math.round(cw * scale); cv.height = Math.round(ch * scale);
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, cv.width, cv.height);
      const dw = Math.round(w * scale), dh = Math.round(h * scale);
      ctx.drawImage(img, Math.round((cv.width - dw) / 2), Math.round((cv.height - dh) / 2), dw, dh);
      const blob = await new Promise((res) => cv.toBlob(res, 'image/jpeg', 0.92));
      if (!blob) throw new ApiError('Gagal mengubah foto ke JPG.');
      return { blob, padded: cw !== w || ch !== h };
    } finally {
      URL.revokeObjectURL(src);
    }
  }

  async function waitContainer(id, token, timeout, onState) {
    const t0 = Date.now();
    for (;;) {
      const j = await graph(id, { token, params: { fields: 'status_code,status' } });
      if (j.status_code === 'FINISHED' || j.status_code === 'PUBLISHED') return;
      if (j.status_code === 'ERROR' || j.status_code === 'EXPIRED') {
        throw new ApiError('Instagram menolak file ini (' + (j.status || j.status_code) + '). Cek format, rasio, dan durasinya.');
      }
      const el = Date.now() - t0;
      if (el > timeout) throw new ApiError('Instagram terlalu lama memproses. Cek aplikasi Instagram beberapa menit lagi.');
      onState('Instagram sedang memproses (' + Math.round(el / 1000) + ' detik)');
      await sleep(el < 60000 ? 4000 : 10000);
    }
  }

  async function publishInstagram(job) {
    const acct = currentIg();
    const tok = acct.pageToken;
    const type = igType();
    const caption = $('igCaption').value.trim();
    let containerId, tempPhotoId;

    if (state.kind === 'image') {
      job.update(5, 'Menyiapkan foto');
      const { blob, padded } = await prepareImage(state.file, type);
      if (padded) job.note('Foto diberi pinggiran putih supaya rasionya diterima Instagram.', 'info');
      job.update(15, 'Mengunggah foto');
      tempPhotoId = await fbUploadPhoto(acct.pageId, tok, blob);
      const ph = await graph(tempPhotoId, { token: tok, params: { fields: 'images' } });
      const imageUrl = ph.images && ph.images[0] && ph.images[0].source;
      if (!imageUrl) throw new ApiError('Gagal mendapatkan link foto sementara dari Facebook.');
      job.update(45, 'Membuat post Instagram');
      const params = { image_url: imageUrl };
      if (type === 'story') params.media_type = 'STORIES';
      else if (caption) params.caption = caption;
      containerId = (await graph(acct.igId + '/media', { method: 'POST', token: tok, params })).id;
    } else {
      job.update(2, 'Menyiapkan upload video');
      const params = { media_type: type === 'story' ? 'STORIES' : 'REELS', upload_type: 'resumable' };
      if (type !== 'story' && caption) params.caption = caption;
      const c = await graph(acct.igId + '/media', { method: 'POST', token: tok, params });
      containerId = c.id;
      const uri = c.uri || 'https://rupload.facebook.com/ig-api-upload/' + GV + '/' + c.id;
      try {
        await xhrSend('POST', uri, state.file,
          { Authorization: 'OAuth ' + tok, offset: '0', file_size: String(state.file.size) },
          (p) => job.update(4 + p * 66, 'Mengunggah video ' + Math.round(p * 100) + '%'));
      } catch (e) {
        if (e.network) throw new ApiError('Upload video ke Instagram terputus atau diblokir browser. Cek internet lalu coba lagi.', { cors: true });
        const err = e.body && (e.body.debug_info || e.body.error);
        throw new ApiError('Instagram menolak upload video: ' + ((err && err.message) || e.text || e.message));
      }
    }

    job.update(state.kind === 'image' ? 60 : 72, 'Instagram sedang memproses');
    await waitContainer(containerId, tok, state.kind === 'video' ? 15 * 60000 : 3 * 60000, (s) => job.update(null, s));
    job.update(94, 'Menerbitkan');
    const pub = await graph(acct.igId + '/media_publish', { method: 'POST', token: tok, params: { creation_id: containerId } });
    let permalink = null;
    try { permalink = (await graph(pub.id, { token: tok, params: { fields: 'permalink' } })).permalink; } catch { /* opsional */ }
    if (tempPhotoId) graph(tempPhotoId, { method: 'POST', token: tok, params: { method: 'delete' } }).catch(() => {});
    return { url: permalink || 'https://www.instagram.com/' + acct.username + '/' };
  }

  // ---------- File ----------
  function setFile(f) {
    $('fileError').hidden = true;
    if (!f) return;
    const isVid = /^video\//.test(f.type) || /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(f.name);
    const isImg = /^image\/(jpeg|png|webp)$/.test(f.type) || /\.(jpe?g|png|webp)$/i.test(f.name);
    if (!isVid && !isImg) {
      $('fileError').textContent = /heic|heif/i.test(f.type + f.name)
        ? 'Foto HEIC dari iPhone belum didukung browser. Ubah ke JPG dulu.'
        : 'File ini bukan video atau foto (JPG, PNG, WebP).';
      $('fileError').hidden = false;
      return;
    }
    state.file = f;
    state.kind = isVid ? 'video' : 'image';
    state.info = {};
    if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
    state.previewUrl = URL.createObjectURL(f);

    const media = $('media');
    let el;
    if (isVid) {
      el = document.createElement('video');
      el.controls = true; el.muted = true; el.playsInline = true; el.preload = 'metadata';
      el.addEventListener('loadedmetadata', () => {
        state.info = { duration: el.duration, w: el.videoWidth, h: el.videoHeight };
        renderFileMeta(); applyKind();
      });
    } else {
      el = document.createElement('img');
      el.alt = 'Pratinjau foto';
      el.addEventListener('load', () => {
        state.info = { w: el.naturalWidth, h: el.naturalHeight };
        renderFileMeta();
      });
    }
    el.src = state.previewUrl;
    media.replaceChildren(el);
    $('fileName').textContent = f.name;
    renderFileMeta();
    $('preview').hidden = false;
    $('drop').hidden = true;
    if (isVid && !$('ytTitle').value.trim()) { $('ytTitle').value = baseName(f.name).slice(0, 100); countAll(); }
    applyKind();
    updateSend();
  }

  function renderFileMeta() {
    const parts = [];
    if (state.info.duration) parts.push(fmtDur(state.info.duration));
    if (state.info.w) parts.push(state.info.w + '×' + state.info.h);
    parts.push(fmtSize(state.file.size));
    $('fileMeta').textContent = parts.join(', ');
  }

  function clearFile() {
    state.file = null; state.kind = null; state.info = {};
    if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
    state.previewUrl = null;
    $('media').replaceChildren();
    $('preview').hidden = true;
    $('drop').hidden = false;
    $('file').value = '';
    applyKind(); updateSend();
    $('file').focus();
  }

  // ---------- Form ----------
  function igType() { const c = document.querySelector('input[name=igType]:checked'); return c ? c.value : 'reels'; }
  function wantYt() { return $('ytOn').checked && !$('ytOn').disabled; }
  function wantIg() { return $('igOn').checked; }

  function renderIgTypes(options, def) {
    const cur = igType();
    const pick = options.some(([v]) => v === cur) ? cur : def;
    $('igType').replaceChildren(...options.map(([v, label]) => {
      const l = document.createElement('label');
      const i = document.createElement('input');
      i.type = 'radio'; i.name = 'igType'; i.value = v; i.checked = v === pick;
      i.addEventListener('change', applyIgType);
      const s = document.createElement('span'); s.textContent = label;
      l.append(i, s);
      return l;
    }));
    applyIgType();
  }

  function applyIgType() {
    const story = igType() === 'story';
    $('igCaptionWrap').hidden = story;
    $('copyFromYt').hidden = story || !wantYt();
    $('igStoryNote').hidden = !story;
  }

  function applyKind() {
    const ytOn = $('ytOn'), note = $('ytNote');
    if (state.kind === 'image') {
      ytOn.disabled = true;
      ytOn.checked = false;
      note.hidden = false;
      note.textContent = 'YouTube cuma menerima video, jadi foto ini hanya dikirim ke Instagram.';
      renderIgTypes([['feed', 'Feed'], ['story', 'Story']], 'feed');
    } else {
      if (ytOn.disabled) { ytOn.disabled = false; ytOn.checked = store.get('defaults', {}).ytOn !== false; }
      const { w, h, duration } = state.info;
      if (state.kind === 'video' && w && h >= w && duration && duration <= 180) {
        note.hidden = false;
        note.textContent = 'Video vertikal di bawah 3 menit otomatis jadi YouTube Shorts.';
      } else note.hidden = true;
      renderIgTypes([['reels', 'Reels'], ['story', 'Story']], 'reels');
    }
    $('ytBox').classList.toggle('off', !wantYt());
    $('igBox').classList.toggle('off', !wantIg());
    $('copyFromYt').hidden = !wantYt() || igType() === 'story';
  }

  function countAll() {
    $('ytTitleCount').textContent = $('ytTitle').value.length + '/100';
    $('ytDescCount').textContent = fmtNum($('ytDesc').value.length) + '/5.000';
    $('igCapCount').textContent = fmtNum($('igCaption').value.length) + '/2.200';
  }

  function updateSend() {
    $('send').disabled = state.busy || !state.file || (!wantYt() && !wantIg());
  }

  function validate() {
    const errs = [];
    if (!state.file) errs.push('Pilih file dulu.');
    const yt = wantYt(), ig = wantIg();
    if (!yt && !ig) errs.push('Centang minimal satu tujuan.');
    if (yt) {
      if (!C.GOOGLE_CLIENT_ID) errs.push('YouTube belum disetel di config.js.');
      else if (!state.yt.token) errs.push('Hubungkan YouTube dulu.');
      if (/[<>]/.test($('ytTitle').value + $('ytDesc').value)) errs.push('Judul dan deskripsi YouTube nggak boleh berisi tanda < atau >.');
      const s = $('ytSchedule').value;
      if (s && new Date(s).getTime() < Date.now() + 5 * 60000) errs.push('Jadwal tayang minimal 5 menit dari sekarang.');
    }
    if (ig) {
      if (!currentIg()) errs.push('Hubungkan Instagram dulu.');
      const tags = ($('igCaption').value.match(/#[^\s#]+/g) || []).length;
      if (igType() !== 'story' && tags > 30) errs.push('Caption Instagram maksimal 30 hashtag (sekarang ' + tags + ').');
      const d = state.info.duration;
      if (state.kind === 'video' && d) {
        if (igType() === 'story' && d > 60) errs.push('Story video maksimal 60 detik. Pilih Reels atau potong videonya.');
        if (igType() === 'reels' && (d < 3 || d > 900)) errs.push('Reels harus 3 detik sampai 15 menit.');
      }
    }
    return errs;
  }

  // ---------- Jobs ----------
  function makeJob(name) {
    const li = document.createElement('li');
    li.className = 'job';
    li.innerHTML = '<div class="job-head"><strong class="job-name"></strong><span class="job-state">Menunggu</span></div>'
      + '<div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span></span></div>'
      + '<p class="job-msg" hidden></p><p class="job-links" hidden></p>';
    li.querySelector('.job-name').textContent = name;
    $('jobs').append(li);
    const st = li.querySelector('.job-state'), bar = li.querySelector('.bar'), fill = bar.firstElementChild;
    const msg = li.querySelector('.job-msg'), links = li.querySelector('.job-links');
    let pct = 0;
    const job = {
      update(p, text) {
        if (p != null) {
          pct = Math.max(pct, Math.min(100, p));
          fill.style.width = pct + '%';
          bar.setAttribute('aria-valuenow', String(Math.round(pct)));
        }
        if (text) st.textContent = text;
      },
      note(text, tone) { msg.hidden = false; msg.className = 'job-msg' + (tone ? ' ' + tone : ''); msg.textContent = text; },
      done(r) {
        li.classList.add('ok');
        job.update(100, 'Selesai');
        links.hidden = false;
        links.replaceChildren(link(r.url, 'Lihat hasilnya'));
        if (r.extra) links.append(link(r.extra[0], r.extra[1]));
        if (r.warn) job.note(r.warn, 'warn');
        else if (r.info) job.note(r.info, 'info');
      },
      fail(e) {
        li.classList.add('bad');
        st.textContent = 'Gagal';
        job.note((e && e.message) || 'Terjadi kesalahan.');
        console.error(name, e);
      },
    };
    return job;
  }

  async function startUpload() {
    const errs = validate();
    if (errs.length) { showHint(errs.join(' '), 'bad'); return; }
    showHint('');
    state.busy = true; updateSend(); lock(true);
    $('send').textContent = 'Sedang mengunggah…';
    $('jobs').replaceChildren();
    const rec = { time: Date.now(), name: state.file.name };
    const tasks = [];
    if (wantYt()) {
      const job = makeJob('YouTube');
      tasks.push(publishYouTube(job).then((r) => { job.done(r); rec.yt = r.url; }, (e) => job.fail(e)));
    }
    if (wantIg()) {
      const job = makeJob('Instagram');
      tasks.push(publishInstagram(job).then((r) => { job.done(r); rec.ig = r.url; }, (e) => job.fail(e)));
    }
    await Promise.all(tasks);
    if (rec.yt || rec.ig) addHistory(rec);
    state.busy = false; lock(false); updateSend();
    $('send').textContent = 'Upload sekarang';
  }

  function lock(on) {
    document.querySelectorAll('.lockable').forEach((s) => { if (on) s.setAttribute('inert', ''); else s.removeAttribute('inert'); });
  }

  // ---------- Riwayat ----------
  function addHistory(rec) {
    const list = store.get('history', []);
    list.unshift(rec);
    store.set('history', list.slice(0, 20));
    renderHistory();
  }
  function renderHistory() {
    const ul = $('history');
    const list = store.get('history', []);
    if (!list.length) {
      const li = document.createElement('li'); li.className = 'empty'; li.textContent = 'Belum ada upload dari perangkat ini.';
      ul.replaceChildren(li); return;
    }
    ul.replaceChildren(...list.map((r) => {
      const li = document.createElement('li');
      const n = document.createElement('p'); n.className = 'h-name'; n.textContent = r.name;
      const m = document.createElement('p'); m.className = 'h-meta';
      const t = document.createElement('span'); t.textContent = new Date(r.time).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
      m.append(t);
      if (r.yt) m.append(link(r.yt, 'YouTube'));
      if (r.ig) m.append(link(r.ig, 'Instagram'));
      li.append(n, m);
      return li;
    }));
  }

  // ---------- Pengaturan bawaan ----------
  function loadDefaults() {
    const d = store.get('defaults', {});
    if (d.tags) $('ytTags').value = d.tags;
    if (d.category) $('ytCategory').value = d.category;
    if (d.privacy) $('ytPrivacy').value = d.privacy;
    if (typeof d.ytOn === 'boolean') $('ytOn').checked = d.ytOn;
    if (typeof d.igOn === 'boolean') $('igOn').checked = d.igOn;
  }
  function saveDefaults() {
    const prev = store.get('defaults', {});
    store.set('defaults', {
      tags: $('ytTags').value, category: $('ytCategory').value, privacy: $('ytPrivacy').value,
      ytOn: $('ytOn').disabled ? prev.ytOn !== false : $('ytOn').checked, igOn: $('igOn').checked,
    });
  }

  // ---------- Pasang event ----------
  function bind() {
    const missing = [];
    if (!C.GOOGLE_CLIENT_ID) missing.push('Google (YouTube)');
    if (!C.META_APP_ID) missing.push('Meta (Instagram)');
    if (missing.length) {
      $('setupNotice').hidden = false;
      $('setupNotice').textContent = 'Website ini belum disambungkan ke ' + missing.join(' dan ') + '. Isi ID-nya di config.js.';
    }

    $('ytConnect').addEventListener('click', toggleYt);
    $('igConnect').addEventListener('click', toggleIg);
    $('igPick').addEventListener('change', (e) => { state.ig.selectedId = e.target.value; store.set('ig.selected', e.target.value); renderIg(); });

    $('file').addEventListener('change', (e) => setFile(e.target.files[0]));
    $('fileChange').addEventListener('click', clearFile);
    const drop = $('drop');
    ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, () => drop.classList.remove('over')));
    drop.addEventListener('drop', (e) => { e.preventDefault(); setFile(e.dataTransfer.files[0]); });

    ['ytTitle', 'ytDesc', 'igCaption'].forEach((id) => $(id).addEventListener('input', countAll));
    ['ytOn', 'igOn'].forEach((id) => $(id).addEventListener('change', () => { saveDefaults(); applyKind(); updateSend(); }));
    ['ytTags', 'ytCategory', 'ytPrivacy'].forEach((id) => $(id).addEventListener('change', saveDefaults));

    $('copyFromYt').addEventListener('click', () => {
      const t = $('ytTitle').value.trim(), d = $('ytDesc').value.trim();
      $('igCaption').value = [t, d].filter(Boolean).join('\n\n').slice(0, 2200);
      countAll();
      $('igCaption').focus();
    });

    $('send').addEventListener('click', () => {
      if (state.busy) return;
      // Token YouTube habis (umur 1 jam): perbarui dulu, upload lanjut otomatis setelah login.
      if (wantYt() && state.yt.client && state.yt.token && !ytReady()) {
        state.yt.pending = true;
        showHint('Login YouTube diperbarui dulu…');
        state.yt.client.requestAccessToken({ prompt: '' });
        return;
      }
      startUpload();
    });

    window.addEventListener('beforeunload', (e) => { if (state.busy) { e.preventDefault(); e.returnValue = ''; } });
  }

  loadDefaults();
  bind();
  countAll();
  applyKind();
  renderHistory();
  initGoogle();
  initMeta();
})();
