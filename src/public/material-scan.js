(() => {
'use strict';

const vendor = '/vendor/zxing-wasm/3.1.5/';
const formats = ['QRCode', 'Code128', 'Code39', 'EAN13', 'EAN8', 'UPCA', 'UPCE', 'DataMatrix'];
let active = null, enginePromise = null;

function engine() {
  if (!enginePromise) enginePromise = (async () => {
    if (typeof WebAssembly !== 'object') throw Error('当前浏览器不支持条码解析，请手动输入。');
    if (!globalThis.ZXingWASM) await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const timer = setTimeout(() => finish(Error('扫码组件加载超时，请重试或手动输入。')), 20000);
      function finish(error) {
        clearTimeout(timer); script.onload = script.onerror = null;
        if (error) { script.remove(); reject(error); } else resolve();
      }
      script.src = vendor + 'index.js'; script.async = true;
      script.onload = () => finish();
      script.onerror = () => finish(Error('扫码组件加载失败，请重试或手动输入。'));
      document.head.appendChild(script);
    });
    const library = globalThis.ZXingWASM;
    if (!library?.readBarcodes || !library?.writeBarcode) throw Error('扫码组件不可用，请手动输入。');
    await library.prepareZXingModule({
      overrides: { locateFile: name => vendor + name.split('/').pop() }, fireImmediately: true
    });
    return library;
  })().catch(error => { globalThis.ZXingWASM?.purgeZXingModule?.(); enginePromise = null; throw error; });
  return enginePromise;
}

function stopTracks(stream) { stream?.getTracks().forEach(track => track.stop()); }
function close() { active?.finish(null); }
function cameraUnavailableMessage() {
  if (!globalThis.isSecureContext) return (globalThis.location?.protocol === 'http:' ? '当前使用 HTTP，浏览器禁止实时相机。' : '当前连接不满足浏览器的相机安全要求。') + '请通过浏览器信任的 HTTPS 地址打开；群晖 IP 需配置 HTTPS 并让手机信任证书，仅跳过证书警告不够。仍可拍照、选图或手动输入。';
  if (typeof navigator.mediaDevices?.getUserMedia !== 'function') return '当前浏览器不支持实时相机，请使用支持相机的浏览器直接打开，并检查网站相机权限；仍可拍照、选图或手动输入。';
  return '';
}

function scan() {
  close();
  return new Promise(resolve => {
    const previousFocus = document.activeElement;
    const dialog = document.createElement('dialog');
    dialog.className = 'ms-dialog';
    dialog.setAttribute('aria-labelledby', 'ms-title');
    dialog.innerHTML = `<div class="ms-head"><h2 id="ms-title">扫描条码 / 二维码</h2><button type="button" data-ms="close" aria-label="关闭扫码">×</button></div>
      <div class="ms-body"><p class="ms-help">对准一个条码。照片和摄像画面仅在当前设备解析，不上传。EAN/UPC 等价码可能采用 13 位表示，绑定时请以扫码结果为准。</p>
      <video class="ms-video" playsinline muted autoplay hidden aria-label="后置摄像头预览"></video>
      <p class="ms-status" role="status" aria-live="polite"></p>
      <div class="ms-actions"><button type="button" class="primary" data-ms="camera">开启后置摄像头</button><button type="button" class="ghost" data-ms="stop" hidden>停止摄像头</button></div>
      <div class="ms-actions ms-files"><label>拍照识别<input data-ms="photo" type="file" accept="image/*" capture="environment"></label><label>选择图片<input data-ms="file" type="file" accept="image/*"></label></div>
      <form class="ms-manual"><label>也可手动输入条码内容<input name="code" maxlength="4096" autocomplete="off" autocapitalize="off" spellcheck="false" required></label><button type="submit" class="primary">使用输入内容</button></form></div>`;
    const video = dialog.querySelector('video');
    const status = dialog.querySelector('.ms-status');
    const startButton = dialog.querySelector('[data-ms="camera"]');
    const stopButton = dialog.querySelector('[data-ms="stop"]');
    const manual = dialog.querySelector('.ms-manual');
    const canvas = document.createElement('canvas');
    const session = { done: false, stream: null, timer: null, cameraJob: 0, imageJob: 0, imageUrl: null };
    active = session;
    const live = () => !session.done && active === session;
    const message = text => { if (live()) status.textContent = text; };
    function stopCamera() {
      session.cameraJob++; clearTimeout(session.timer); session.timer = null;
      stopTracks(session.stream); session.stream = null;
      video.pause(); video.srcObject = null; video.hidden = true;
      startButton.disabled = false; stopButton.hidden = true;
    }
    session.stopCamera = stopCamera;
    session.finish = value => {
      if (session.done) return;
      session.done = true; stopCamera(); session.imageJob++;
      if (session.imageUrl) URL.revokeObjectURL(session.imageUrl);
      session.imageUrl = null;
      if (active === session) active = null;
      if (typeof dialog.close === 'function') dialog.close();
      dialog.remove();
      if (previousFocus?.isConnected) previousFocus.focus();
      resolve(value);
    };
    function valueFrom(results) {
      const values = [...new Set(results.filter(row => row.isValid !== false && !row.error && typeof row.text === 'string' && row.text.trim()).map(row => row.text))];
      if (values.length > 1) { message('检测到多个条码，请只对准一个目标，或裁剪图片后重试。'); return null; }
      if (values[0]?.length > 4096) { message('条码内容过长，请使用物资标签或手动输入编码。'); return null; }
      return values[0] || null;
    }
    function pixels(source, width, height, limit) {
      if (!width || !height) throw Error('图片尺寸无效，请重新拍照或选择图片。');
      const scale = Math.min(1, limit / Math.max(width, height));
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw Error('当前浏览器无法解析图片，请手动输入。');
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      return context.getImageData(0, 0, canvas.width, canvas.height);
    }
    async function startCamera() {
      stopCamera();
      session.imageJob++;
      if (session.imageUrl) URL.revokeObjectURL(session.imageUrl);
      session.imageUrl = null;
      const unavailable = cameraUnavailableMessage();
      if (unavailable) { message(unavailable); return; }
      const job = session.cameraJob;
      startButton.disabled = true; message('正在准备摄像头，请允许使用相机。');
      let stream, preparingDecoder = false;
      try {
        // Request permission during the button gesture, before awaiting the decoder download.
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } });
        if (!live() || job !== session.cameraJob || document.hidden) {
          stopTracks(stream);
          if (live() && job === session.cameraJob) stopCamera();
          return;
        }
        session.stream = stream; video.srcObject = stream; video.hidden = false;
        await video.play();
        if (!live() || job !== session.cameraJob) { stopTracks(stream); return; }
        stopButton.hidden = false; message('相机已开启，正在准备本地识别组件…');
        preparingDecoder = true;
        const library = await engine();
        preparingDecoder = false;
        if (!live() || job !== session.cameraJob) return;
        message('将一个条码放在画面内，保持清晰并稍作停留。');
        async function detect() {
          if (!live() || job !== session.cameraJob) return;
          try {
            if (video.readyState >= 2 && video.videoWidth) {
              const results = await library.readBarcodes(pixels(video, video.videoWidth, video.videoHeight, 1280), { formats, tryHarder: true, maxNumberOfSymbols: 3 });
              if (!live() || job !== session.cameraJob) return;
              const value = valueFrom(results);
              if (value) { session.finish(value); return; }
            }
            session.timer = setTimeout(detect, 250);
          } catch {
            if (live() && job === session.cameraJob) { stopCamera(); message('实时识别失败，可重新开启相机、选图或手动输入。'); }
          }
        }
        await detect();
      } catch (error) {
        stopTracks(stream);
        if (!live() || job !== session.cameraJob) return;
        stopCamera();
        const errors = {
          NotAllowedError: '相机权限未获允许，请在浏览器和系统设置中允许相机后重试。',
          SecurityError: '浏览器安全策略阻止了相机，请直接打开可信 HTTPS 地址并检查网站相机权限。',
          NotFoundError: '未找到可用摄像头，请确认设备连接了摄像头。',
          NotReadableError: '无法读取摄像头，可能被其他应用占用，请关闭占用相机的应用后重试。',
          OverconstrainedError: '摄像头不支持当前拍摄设置，请更换浏览器后重试。',
          AbortError: '摄像头启动已中断，请重试。'
        };
        message(preparingDecoder ? '扫码组件加载失败，无法启动实时识别，请重试或手动输入。' : (errors[error.name] || '无法开启摄像头，请重试。') + '也可拍照、选图或手动输入。');
      }
    }
    async function readFile(input) {
      const file = input.files?.[0]; input.value = '';
      if (!file || !live()) return;
      stopCamera(); const job = ++session.imageJob;
      if (file.size > 20 * 1024 * 1024) { message('图片不能超过 20 MiB，请裁剪或降低分辨率后重试。'); return; }
      message('正在本地识别图片…');
      const image = new Image();
      if (session.imageUrl) URL.revokeObjectURL(session.imageUrl);
      const imageUrl = session.imageUrl = URL.createObjectURL(file);
      try {
        const loaded = new Promise((done, fail) => { image.onload = done; image.onerror = () => fail(Error('图片无法读取。')); });
        image.src = imageUrl; await loaded;
        if (!live() || job !== session.imageJob) return;
        const library = await engine();
        if (!live() || job !== session.imageJob) return;
        const results = await library.readBarcodes(pixels(image, image.naturalWidth, image.naturalHeight, 2000), { formats, tryHarder: true, maxNumberOfSymbols: 3 });
        if (!live() || job !== session.imageJob) return;
        const value = valueFrom(results);
        if (value) session.finish(value);
        else if (results.length < 2) message('未识别出条码，请拍清楚完整条码、裁剪后重试或手动输入。');
      } catch {
        if (live() && job === session.imageJob) message('图片识别失败，请改用 JPG/PNG 清晰图片或手动输入。');
      } finally {
        URL.revokeObjectURL(imageUrl);
        if (session.imageUrl === imageUrl) session.imageUrl = null;
      }
    }
    dialog.querySelector('[data-ms="close"]').onclick = close;
    startButton.onclick = startCamera;
    stopButton.onclick = () => { stopCamera(); message('摄像头已停止，可重新开启或使用图片、手动输入。'); };
    for (const input of dialog.querySelectorAll('input[type="file"]')) input.onchange = () => readFile(input);
    manual.onsubmit = event => {
      event.preventDefault(); const value = manual.elements.code.value.trim();
      if (!value || value.length > 4096) { message('请输入 1–4096 个字符的条码内容。'); return; }
      session.finish(value);
    };
    dialog.addEventListener('cancel', event => { event.preventDefault(); session.finish(null); });
    dialog.addEventListener('close', () => session.finish(null));
    document.body.appendChild(dialog);
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else { dialog.setAttribute('open', ''); dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); }
    const unavailable = cameraUnavailableMessage();
    message(unavailable || '点击开启摄像头，或使用拍照、选图、手动输入。');
    if (!unavailable) startButton.focus();
    else manual.elements.code.focus();
  });
}

async function createQr(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 4096) throw Error('二维码内容须为 1–4096 个字符。');
  const library = await engine();
  const result = await library.writeBarcode(text, { format: 'QRCode', options: 'ecLevel=M', scale: 5, addQuietZones: true, addHRT: false });
  if (result.error || !result.image) throw Error('二维码生成失败，请缩短标签内容后重试。');
  return result.image;
}


globalThis.MaterialScanner = Object.freeze({ scan, close, createQr });
addEventListener('pagehide', close);
addEventListener('hashchange', close);
addEventListener('popstate', close);
document.addEventListener('visibilitychange', () => { if (document.hidden) { active?.stopCamera(); } });
document.addEventListener('click', event => { if (event.target.closest?.('[data-nav], [data-mw="page"], #logout')) close(); });
})();
