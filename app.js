'use strict';
(() => {
  const C = window.APP_CONFIG || {};
  const YT_UPLOAD = 'https://www.googleapis.com/auth/youtube.upload';
  const YT_SCOPES = YT_UPLOAD + ' https://www.googleapis.com/auth/youtube.readonly';

  const $ = (id) => document.getElementById(id);
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
    busy: false,
  };

  // ---------- Umum ----------
  function setYtStatus(text, tone) {
    const el = $('ytStatus');
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
  function button(text, cls, onClick) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn ' + cls; b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
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
          reject(new ApiError('HTTP ' + x.status, { status: x.status, body: j }));
        }
      };
      x.onerror = () => reject(new ApiError('network', { network: true }));
      x.send(body);
    });
  }

  // Salin teks secara sinkron supaya tetap dalam satu klik (perlu untuk menu share HP).
  function copyText(text) {
    let ok = false;
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', '');
    ta.style.position = 'fixed'; ta.style.top = '0'; ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    if (!ok && navigator.clipboard) { navigator.clipboard.writeText(text).catch(() => {}); ok = true; }
    return ok;
  }

  // ---------- YouTube ----------
  function ytReady() { return !!(state.yt.token && state.yt.exp > Date.now()); }

  function initGoogle(tries = 0) {
    if (!C.GOOGLE_CLIENT_ID) { setYtStatus('Belum disetel di config.js'); $('ytConnect').disabled = true; return; }
    if (!(window.google && google.accounts && google.accounts.oauth2)) {
      if (tries < 60) setTimeout(() => initGoogle(tries + 1), 200);
      else setYtStatus('Login Google gagal dimuat. Muat ulang halaman.', 'bad');
      return;
    }
    state.yt.client = google.accounts.oauth2.initTokenClient({
      client_id: C.GOOGLE_CLIENT_ID,
      scope: YT_SCOPES,
      callback: onYtToken,
      error_callback: (e) => {
        state.yt.pending = false;
        const t = e && e.type;
        setYtStatus(t === 'popup_closed' ? 'Login dibatalkan'
          : t === 'popup_failed_to_open' ? 'Jendela login diblokir. Izinkan pop-up untuk situs ini lalu coba lagi.'
            : 'Login Google gagal. Coba lagi.', 'bad');
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
      setYtStatus('Login Google gagal: ' + ((resp && resp.error) || 'tidak diketahui'), 'bad');
      return;
    }
    if (!google.accounts.oauth2.hasGrantedAllScopes(resp, YT_UPLOAD)) {
      state.yt.pending = false;
      setYtStatus('Izin upload belum dicentang. Hubungkan lagi dan centang semua izin.', 'bad');
      return;
    }
    state.yt.token = resp.access_token;
    state.yt.exp = Date.now() + (Number(resp.expires_in || 3600) - 60) * 1000;
    loadYtChannel();
  }

  async function loadYtChannel() {
    setYtStatus('Memuat channel…');
    try {
      const r = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
        headers: { Authorization: 'Bearer ' + state.yt.token },
      });
      const j = await r.json();
      if (!r.ok) throw new Error((j.error && j.error.message) || r.status);
      const ch = j.items && j.items[0];
      if (!ch) {
        state.yt.token = null;
        setYtStatus('Akun Google ini belum punya channel YouTube.', 'bad');
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
    if (C.GOOGLE_CLIENT_ID) setYtStatus(on ? 'Terhubung' : 'Belum terhubung', on ? 'ok' : '');
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

  // ---------- Instagram (dibagikan dari perangkat) ----------
  function igCaption() {
    const c = $('igCaption').value.trim();
    if (c) return c;
    if (!$('ytOn').disabled) return [$('ytTitle').value.trim(), $('ytDesc').value.trim()].filter(Boolean).join('\n\n').slice(0, 2200);
    return '';
  }
  function canShareFile(f) {
    try { return !!(navigator.canShare && navigator.share && navigator.canShare({ files: [f] })); } catch { return false; }
  }

  function makeIgCard(rec) {
    const job = makeJob('Instagram', false);
    const file = state.file;
    const caption = igCaption();
    const copyNote = caption ? 'Caption sudah tersalin, tinggal tempel di Instagram.' : 'Caption kosong, jadi nggak ada yang disalin.';
    const markDone = (msg) => {
      job.setState('Dibagikan', 'ok');
      job.note(msg, 'info');
      rec.ig = true; saveRec(rec);
    };

    if (canShareFile(file)) {
      job.setState('Siap dibagikan');
      job.note('Klik tombol di bawah, lalu pilih Instagram (Reels, Feed, atau Story) di menu share.', 'info');
      job.actions(button('Bagikan ke Instagram', 'primary-sm', async () => {
        if (caption) copyText(caption);
        try {
          await navigator.share({ files: [file] });
          markDone(copyNote + ' Selesaikan posting di aplikasi Instagram.');
        } catch (e) {
          if (e && e.name === 'AbortError') job.note('Menu share ditutup. Klik tombolnya lagi kalau mau lanjut.', 'info');
          else job.note('Perangkat ini nggak bisa membagikan file langsung. Pakai tombol Buka Instagram.', 'warn');
        }
      }), igOpenButton('Buka Instagram', 'https://www.instagram.com/', caption, markDone, copyNote));
    } else {
      job.setState('Siap diposting');
      job.note('Klik salah satu tombol: caption otomatis tersalin dan Instagram atau Meta Business Suite kebuka. Pilih file ' + file.name + ' di sana, tempel caption, lalu posting.', 'info');
      job.actions(
        igOpenButton('Salin caption dan buka Instagram', 'https://www.instagram.com/', caption, markDone, copyNote),
        igOpenButton('Buka Meta Business Suite (bisa jadwal)', 'https://business.facebook.com/', caption, markDone, copyNote),
      );
    }
    if (caption) {
      job.actions(button('Salin caption saja', 'ghost small', () => {
        copyText(caption);
        job.note('Caption tersalin.', 'info');
      }));
    }
  }

  function igOpenButton(text, url, caption, markDone, copyNote) {
    return button(text, 'ghost', () => {
      if (caption) copyText(caption);
      window.open(url, '_blank', 'noopener');
      markDone(copyNote + ' Instagram dibuka di tab baru.');
    });
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
    $('media').replaceChildren(el);
    $('fileName').textContent = f.name;
    renderFileMeta();
    $('preview').hidden = false;
    $('drop').hidden = true;
    if (isVid && !$('ytTitle').value.trim()) { $('ytTitle').value = baseName(f.name).slice(0, 100); countAll(); }
    $('jobs').replaceChildren();
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
    $('jobs').replaceChildren();
    applyKind(); updateSend();
    $('file').focus();
  }

  // ---------- Form ----------
  function wantYt() { return $('ytOn').checked && !$('ytOn').disabled; }
  function wantIg() { return $('igOn').checked; }

  function applyKind() {
    const ytOn = $('ytOn'), note = $('ytNote');
    if (state.kind === 'image') {
      ytOn.disabled = true;
      ytOn.checked = false;
      note.hidden = false;
      note.textContent = 'YouTube cuma menerima video, jadi foto ini hanya disiapkan untuk Instagram.';
    } else {
      if (ytOn.disabled) { ytOn.disabled = false; ytOn.checked = store.get('defaults', {}).ytOn !== false; }
      const { w, h, duration } = state.info;
      if (state.kind === 'video' && w && h >= w && duration && duration <= 180) {
        note.hidden = false;
        note.textContent = 'Video vertikal di bawah 3 menit otomatis jadi YouTube Shorts.';
      } else note.hidden = true;
    }
    $('ytBox').classList.toggle('off', !wantYt());
    $('igBox').classList.toggle('off', !wantIg());
    $('copyFromYt').hidden = !wantYt();
    $('send').textContent = wantYt() ? 'Upload sekarang' : 'Siapkan untuk Instagram';
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
      else if (!state.yt.token) errs.push('Hubungkan YouTube dulu di langkah 1.');
      if (/[<>]/.test($('ytTitle').value + $('ytDesc').value)) errs.push('Judul dan deskripsi YouTube nggak boleh berisi tanda < atau >.');
      const s = $('ytSchedule').value;
      if (s && new Date(s).getTime() < Date.now() + 5 * 60000) errs.push('Jadwal tayang minimal 5 menit dari sekarang.');
    }
    if (ig) {
      const tags = (igCaption().match(/#[^\s#]+/g) || []).length;
      if (tags > 30) errs.push('Caption Instagram maksimal 30 hashtag (sekarang ' + tags + ').');
    }
    return errs;
  }

  // ---------- Kartu progres ----------
  function makeJob(name, withBar = true) {
    const li = document.createElement('li');
    li.className = 'job';
    li.innerHTML = '<div class="job-head"><strong class="job-name"></strong><span class="job-state">Menunggu</span></div>'
      + (withBar ? '<div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span></span></div>' : '')
      + '<p class="job-msg" hidden></p><div class="job-actions" hidden></div><p class="job-links" hidden></p>';
    li.querySelector('.job-name').textContent = name;
    $('jobs').append(li);
    const st = li.querySelector('.job-state'), bar = li.querySelector('.bar'), fill = bar && bar.firstElementChild;
    const msg = li.querySelector('.job-msg'), acts = li.querySelector('.job-actions'), links = li.querySelector('.job-links');
    let pct = 0;
    const job = {
      update(p, text) {
        if (p != null && bar) {
          pct = Math.max(pct, Math.min(100, p));
          fill.style.width = pct + '%';
          bar.setAttribute('aria-valuenow', String(Math.round(pct)));
        }
        if (text) st.textContent = text;
      },
      setState(text, tone) { st.textContent = text; li.classList.remove('ok', 'bad'); if (tone) li.classList.add(tone); },
      note(text, tone) { msg.hidden = false; msg.className = 'job-msg' + (tone ? ' ' + tone : ''); msg.textContent = text; },
      actions(...els) { acts.hidden = false; acts.append(...els); },
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
    $('jobs').replaceChildren();
    const rec = { id: Date.now(), time: Date.now(), name: state.file.name };
    if (wantIg()) makeIgCard(rec);
    if (!wantYt()) return;

    state.busy = true; updateSend(); lock(true);
    $('send').textContent = 'Sedang mengunggah…';
    const job = makeJob('YouTube');
    $('jobs').prepend($('jobs').lastElementChild);
    try {
      const r = await publishYouTube(job);
      job.done(r);
      rec.yt = r.url;
      saveRec(rec);
    } catch (e) {
      job.fail(e);
    }
    state.busy = false; lock(false); updateSend();
    applyKind();
  }

  function lock(on) {
    document.querySelectorAll('.lockable').forEach((s) => { if (on) s.setAttribute('inert', ''); else s.removeAttribute('inert'); });
  }

  // ---------- Riwayat ----------
  function saveRec(rec) {
    const list = store.get('history', []).filter((r) => r.id !== rec.id);
    list.unshift({ ...rec });
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
      if (r.ig) { const s = document.createElement('span'); s.textContent = 'Instagram: dibagikan'; m.append(s); }
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
    if (!C.GOOGLE_CLIENT_ID) {
      $('setupNotice').hidden = false;
      $('setupNotice').textContent = 'Website ini belum disambungkan ke Google (YouTube). Isi GOOGLE_CLIENT_ID di config.js.';
    }

    $('ytConnect').addEventListener('click', toggleYt);

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
})();
