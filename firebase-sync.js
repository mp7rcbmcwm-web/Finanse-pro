/* Karacaahmet Tarım Firebase istemci katmanı. Canlı bağlantı yalnızca geçerli config ile kurulur. */
(function () {
  const $ = id => document.getElementById(id);
  const status = $('fb-status');
  const actions = $('fb-cloud-actions');
  const authFields = $('fb-auth-fields');
  let auth = null, db = null, currentUser = null, baseRevision = null, docRef = null, busy = false, localDirty = false, unsubscribeDoc = null, syncQueued = false, syncBlocked = false;
  let minimized = false;
  function say(msg, tone) { status.textContent = msg; status.style.color = tone === 'ok' ? '#047857' : tone === 'error' ? '#b91c1c' : '#475569'; }
  function setBusy(v) { busy = v; ['fb-signin','fb-signup','fb-google','fb-upload','fb-refresh','fb-signout'].forEach(id => { const el=$(id); if(el) el.disabled=v; }); }
  function getLocal() { if (!window.__ktGetData) throw new Error('Uygulama veri köprüsü bulunamadı.'); return window.__ktGetData(); }
  function getCounts(d) { return `Satış ${d.sales.length}, alış ${d.purchases.length}, gider ${d.expenses.length}, kart ${d.cards.length}, kart ödemesi ${d.cardPays.length}, kasa ${d.cashMoves.length}`; }
  function currentDoc() { if (!currentUser) throw new Error('Önce giriş yapın.'); return db.collection('users').doc(currentUser.uid).collection('appData').doc('main'); }
  async function refreshCloud(confirmReplace) {
    if (!currentUser) throw new Error('Önce giriş yapın.');
    const snap = await currentDoc().get();
    if (!snap.exists) { baseRevision = null; say('Bulutta henüz veri yok. Bu cihazdaki kayıtlar korunuyor; ilk aktarım için yeşil düğmeyi kullanın.'); $('fb-upload').style.display='inline-block'; $('fb-refresh').style.display='none'; return; }
    const remote = snap.data();
    if (!remote || remote.ownerUid !== currentUser.uid || !remote.payload || !Number.isInteger(remote.revision)) throw new Error('Bulut belgesinin yapısı doğrulanamadı; veri uygulanmadı.');
    if (confirmReplace && !window.confirm('Buluttaki kayıtlar bu cihazdaki yerel kayıtların yerine yüklenecek. Yerel verilerinizin ayrı bir yedeği olduğundan emin olun. Devam edilsin mi?')) return;
    window.__ktApplyData(remote.payload);
    baseRevision = remote.revision; localDirty = false; syncBlocked = false; syncQueued = false;
    startRealtimeListener();
    $('fb-upload').style.display='none'; $('fb-refresh').style.display='inline-block';
    say('Bulut verisi bu cihaza yüklendi. Revizyon: '+baseRevision+'. '+getCounts(remote.payload), 'ok');
  }
  async function firstUpload() {
    if (!currentUser || busy) return;
    if (!window.confirm('Bu cihazdaki mevcut kayıtlar, yeni Firebase hesabının boş bulut kaydına ilk kez aktarılacak. Aktarım kayıtları birleştirmez; mevcut bulut belgesi varsa aktarım reddedilir. Devam edilsin mi?')) return;
    setBusy(true);
    try {
      const ref = currentDoc();
      const payload = getLocal();
      await db.runTransaction(async tx => {
        const snap = await tx.get(ref);
        if (snap.exists) throw new Error('Bulutta zaten kayıt var. Üzerine yazılmadı; Bulutu yenile seçeneğini kullanın.');
        tx.set(ref, { ownerUid: currentUser.uid, schemaVersion: 1, revision: 1, payload, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
      });
      baseRevision = 1; localDirty = false; syncBlocked = false; syncQueued = false; $('fb-upload').style.display='none'; $('fb-refresh').style.display='inline-block'; startRealtimeListener();
      say('İlk aktarım tamamlandı. '+getCounts(payload)+' — ancak diğer cihaz testi henüz yapılmadı.', 'ok');
    } catch (e) { say('İlk aktarım başarısız: '+(e.message||e), 'error'); }
    finally { setBusy(false); }
  }
  async function syncLocalSnapshot() {
    if (!currentUser || baseRevision === null) return;
    if (busy) { syncQueued = true; return; }
    if (syncBlocked) return;
    setBusy(true);
    let failed = false;
    try {
      const ref = currentDoc(), payload = getLocal(), expected = baseRevision;
      const next = await db.runTransaction(async tx => {
        const snap = await tx.get(ref);
        if (!snap.exists) throw new Error('Bulut kaydı silinmiş. Veri gönderilmedi; ilk aktarım akışını kontrol edin.');
        const remote = snap.data();
        if (remote.ownerUid !== currentUser.uid || remote.revision !== expected) throw new Error('Başka bir cihaz bulut verisini değiştirmiş. Bu kaydın üzerine yazmadım. Önce “Bulutu yenile” ile son sürümü inceleyin.');
        const rev = expected + 1;
        tx.set(ref, { ownerUid: currentUser.uid, schemaVersion: 1, revision: rev, payload, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
        return rev;
      });
      baseRevision = next;
      localDirty = JSON.stringify(getLocal()) !== JSON.stringify(payload);
      if (localDirty) syncQueued = true;
      say(localDirty ? 'Son kayıt buluta eşitlendi; daha yeni bir yerel değişiklik de var, o da sıraya alındı.' : 'Cihaza kaydedildi ve buluta eşitlendi. Revizyon: '+baseRevision+'.', 'ok');
    } catch (e) {
      failed = true;
      if ((e.message || '').includes('Başka bir cihaz') || (e.message || '').includes('Bulut kaydı silinmiş')) syncBlocked = true;
      say('Yerel kayıt korunuyor; bulut eşitlemesi tamamlanmadı: '+(e.message||e), 'error');
    } finally {
      setBusy(false);
      if (syncQueued && !syncBlocked && currentUser) { syncQueued = false; setTimeout(syncLocalSnapshot, 0); }
    }
  }
  function startRealtimeListener() {
    if (!currentUser || baseRevision === null || !db) return;
    if (unsubscribeDoc) unsubscribeDoc();
    unsubscribeDoc = currentDoc().onSnapshot(snap => {
      if (!snap.exists) { say('Bulut belgesi bulunamadı; yerel kayıtlar korunuyor.', 'error'); return; }
      const remote = snap.data();
      if (!remote || remote.ownerUid !== currentUser.uid || !Number.isInteger(remote.revision)) { say('Bulut verisi doğrulanamadı; uygulanmadı.', 'error'); return; }
      if (remote.revision <= baseRevision) return;
      if (localDirty || busy) { say('Diğer cihazda yeni revizyon var. Yerel değişiklikler korunuyor; çakışmayı çözmek için Bulutu yenile düğmesini kullanın.', 'error'); return; }
      try {
        window.__ktApplyData(remote.payload);
        baseRevision = remote.revision;
        say('Diğer cihazdan yeni kayıtlar alındı. Revizyon: '+baseRevision+'.', 'ok');
      } catch (e) { say('Yeni bulut verisi uygulanamadı: '+e.message, 'error'); }
    }, err => say('Canlı bulut dinlemesi kesildi; yerel kayıtlar korunuyor: '+err.message, 'error'));
  }
  function authChanged(user) {
    currentUser = user || null;
    if (!user) { if (unsubscribeDoc) { unsubscribeDoc(); unsubscribeDoc=null; } baseRevision = null; docRef = null; localDirty=false; syncBlocked=false; syncQueued=false; authFields.style.display='grid'; actions.style.display='none'; say('Giriş yapılmadı. Uygulama bu cihazda yerel çalışıyor.'); return; }
    authFields.style.display='none'; actions.style.display='flex';
    $('fb-upload').style.display='none'; $('fb-refresh').style.display='inline-block';
    say('Giriş başarılı ('+(user.email || 'Google hesabı')+'). Bulut kaydı kontrol ediliyor…');
    refreshCloud(true).catch(e => say('Bulut okunamadı; yerel veriler korunuyor: '+(e.message||e), 'error'));
  }
  function init() {
    const cfg = window.KARACAAHMET_FIREBASE_CONFIG;
    if (!cfg || !cfg.apiKey || String(cfg.apiKey).includes('BURAYA') || !cfg.projectId || String(cfg.projectId).includes('PROJE_ID')) {
      say('Firebase yapılandırması eksik. firebase-config.example.js dosyasını firebase-config.js adıyla kopyalayıp gerçek Web App ayarlarını girin. Şu an yalnızca yerel kayıt çalışır.'); return;
    }
    if (!window.firebase || !firebase.apps) { say('Firebase SDK yüklenemedi. İnternet bağlantısını kontrol edin. Yerel kayıtlar korunuyor.', 'error'); return; }
    try {
      if (!firebase.apps.length) firebase.initializeApp(cfg);
      auth = firebase.auth(); db = firebase.firestore();
      auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(e => say('Oturum kalıcılığı ayarlanamadı: '+e.message, 'error'));
      auth.onAuthStateChanged(authChanged);
      // Mevcut yerel kaydetme davranışı korunur. Oturum + ilk aktarım sonrası buluta revizyon kontrollü yazılır.
      const originalSaveAll = window.saveAll;
      if (typeof originalSaveAll === 'function' && !window.__ktSaveWrapped) { window.__ktSaveWrapped=true; window.saveAll = function () { originalSaveAll(); localDirty=true; setTimeout(syncLocalSnapshot, 0); }; }
      say('Firebase SDK hazır. Giriş yapabilir veya yerel kullanıma devam edebilirsiniz.');
    } catch (e) { say('Firebase başlatılamadı: '+(e.message||e), 'error'); }
  }
  $('fb-signin').addEventListener('click', async () => { if(busy)return; setBusy(true); try { await auth.signInWithEmailAndPassword($('fb-email').value.trim(), $('fb-password').value); } catch(e){say('E-posta ile giriş başarısız: '+e.message,'error');} finally{setBusy(false);} });
  $('fb-signup').addEventListener('click', async () => { if(busy)return; setBusy(true); try { await auth.createUserWithEmailAndPassword($('fb-email').value.trim(), $('fb-password').value); } catch(e){say('Hesap oluşturulamadı: '+e.message,'error');} finally{setBusy(false);} });
  $('fb-google').addEventListener('click', async () => { if(busy)return; setBusy(true); try { const p=new firebase.auth.GoogleAuthProvider(); await auth.signInWithPopup(p); } catch(e){say('Google girişi başarısız: '+e.message,'error');} finally{setBusy(false);} });
  $('fb-upload').addEventListener('click', firstUpload);
  $('fb-refresh').addEventListener('click', () => refreshCloud(true).catch(e => say('Bulut yenilenemedi: '+e.message,'error')));
  $('fb-signout').addEventListener('click', () => auth.signOut().catch(e=>say('Çıkış yapılamadı: '+e.message,'error')));
  $('fb-minimize').addEventListener('click', () => { minimized=!minimized; ['fb-auth-fields','fb-cloud-actions'].forEach(id=>$(id).style.display=minimized?'none':(id==='fb-auth-fields'?(currentUser?'none':'grid'):(currentUser?'flex':'none'))); status.style.display=minimized?'none':'block'; $('firebase-panel').style.width=minimized?'auto':'min(370px,calc(100vw - 24px))'; $('fb-minimize').textContent=minimized?'+':'−'; });
  window.addEventListener('online', () => { if(currentUser) say('İnternet geri geldi. Yerel veriler korunuyor; gerekirse Bulutu yenile ile son sürümü alın.'); });
  window.addEventListener('offline', () => say('Çevrimdışı: kayıtlar bu cihazda tutulur, bulut eşitlemesi bekler. Otomatik çevrimdışı kuyruk uygulanmıyor; yeniden bağlanınca “Bulutu yenile” ile çakışmayı kontrol edin.'));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
