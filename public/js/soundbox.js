/**
 * Soundbox Kasir Otomatis - Real-time Voice Speaker untuk Admin Portal
 * Mengumumkan setiap transaksi QRIS, Voucher, Tagihan, dan Donasi secara otomatis
 */
(function() {
  'use strict';

  // State
  let isEnabled = localStorage.getItem('admin_soundbox_enabled') !== 'false'; // Default TRUE
  let lastSeenId = 0;
  let isInitialized = false;
  let audioQueue = [];
  let isPlayingAudio = false;
  let audioCtx = null;

  // Inisialisasi Audio Context (Web Audio API untuk bell chime)
  function getAudioContext() {
    if (!audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        audioCtx = new AudioContextClass();
      }
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  }

  /**
   * Bunyikan Bel Kasir Elegan (Chime 2 Nada: 880Hz -> 1320Hz)
   */
  function playCashierChime() {
    return new Promise((resolve) => {
      try {
        const ctx = getAudioContext();
        if (!ctx) return resolve();

        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = 'sine';
        // Nada 1 (A5: 880Hz) lalu Nada 2 (E6: 1318Hz)
        osc.frequency.setValueAtTime(880, now);
        osc.frequency.exponentialRampToValueAtTime(1318.5, now + 0.12);

        gain.gain.setValueAtTime(0.01, now);
        gain.gain.linearRampToValueAtTime(0.3, now + 0.05);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.55);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(now);
        osc.stop(now + 0.6);
        setTimeout(resolve, 550);
      } catch (e) {
        resolve();
      }
    });
  }

  /**
   * Mainkan Suara Google TTS Bahasa Indonesia dari Server
   */
  function playTtsAudio(speechText) {
    return new Promise((resolve) => {
      try {
        const encoded = encodeURIComponent(speechText);
        const url = `/admin/api/voice-assistant/tts?text=${encoded}`;
        const audio = new Audio(url);
        audio.preload = 'auto';

        audio.onended = () => resolve();
        audio.onerror = (e) => {
          console.warn('[Soundbox] Audio playback error:', e);
          resolve();
        };

        const playPromise = audio.play();
        if (playPromise !== undefined) {
          playPromise.catch((err) => {
            console.warn('[Soundbox] Autoplay blocked, but context will resume on user action:', err);
            resolve();
          });
        }
      } catch (err) {
        console.warn('[Soundbox] Audio init error:', err);
        resolve();
      }
    });
  }

  /**
   * Proses antrean suara satu per satu
   */
  async function processAudioQueue() {
    if (isPlayingAudio || audioQueue.length === 0) return;
    if (!isEnabled) {
      audioQueue = [];
      return;
    }

    isPlayingAudio = true;
    const item = audioQueue.shift();

    try {
      // 1. Tampilkan Toast UI
      showSoundboxToast(item);

      // 2. Notifikasi ke halaman Voice Assistant jika sedang dibuka
      window.dispatchEvent(new CustomEvent('soundbox:event', { detail: item }));

      // 3. Mainkan Bel Chime
      await playCashierChime();

      // 4. Mainkan Suara Ucapan
      if (item.speech_text) {
        await playTtsAudio(item.speech_text);
      }
    } catch (e) {
      console.warn('[Soundbox] Queue process error:', e);
    } finally {
      isPlayingAudio = false;
      setTimeout(processAudioQueue, 400);
    }
  }

  /**
   * Tampilkan Toast Notifikasi Pembayaran Mengambang di Pojok Layar
   */
  function showSoundboxToast(ev) {
    let container = document.getElementById('soundboxToastContainer');
    if (!container) {
      container = document.createElement('div');
      container.id = 'soundboxToastContainer';
      container.style.cssText = `
        position: fixed;
        bottom: 24px;
        right: 24px;
        z-index: 99999;
        display: flex;
        flex-direction: column;
        gap: 12px;
        max-width: 360px;
        pointer-events: none;
      `;
      document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = 'soundbox-toast-card';
    toast.style.cssText = `
      pointer-events: auto;
      background: linear-gradient(135deg, rgba(15, 23, 42, 0.96), rgba(30, 41, 59, 0.96));
      border: 1px solid rgba(16, 185, 129, 0.5);
      border-radius: 16px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.5), 0 0 20px rgba(16, 185, 129, 0.3);
      padding: 14px 16px;
      color: #f8fafc;
      font-family: inherit;
      display: flex;
      align-items: center;
      gap: 12px;
      backdrop-filter: blur(12px);
      transform: translateX(120%);
      transition: transform 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275), opacity 0.35s ease;
      opacity: 0;
    `;

    const iconType = ev.type === 'voucher' ? 'bi-ticket-perforated-fill' : 
                     ev.type === 'invoice' ? 'bi-receipt' :
                     ev.type === 'donation' ? 'bi-heart-fill' : 'bi-cash-coin';

    const formattedAmt = Number(ev.amount || 0).toLocaleString('id-ID');

    toast.innerHTML = `
      <div style="width: 44px; height: 44px; border-radius: 12px; background: rgba(16, 185, 129, 0.2); border: 1px solid rgba(16, 185, 129, 0.4); display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
        <i class="bi ${iconType}" style="font-size: 22px; color: #10b981;"></i>
      </div>
      <div style="flex: 1; min-width: 0;">
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 6px;">
          <span style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #10b981;">${ev.title || 'DANA MASUK'}</span>
          <span style="font-size: 10px; color: #94a3b8;">Baru saja</span>
        </div>
        <div style="font-size: 15px; font-weight: 800; color: #ffffff; margin-top: 2px;">
          Rp ${formattedAmt}
        </div>
        <div style="font-size: 12px; color: #cbd5e1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px;">
          ${ev.customer_name ? (ev.type === 'voucher' ? 'Paket: ' : 'Nama: ') + ev.customer_name : (ev.speech_text || '')}
        </div>
      </div>
      <button style="background: none; border: none; color: #64748b; font-size: 18px; cursor: pointer; padding: 4px;" onclick="this.parentElement.remove()">
        <i class="bi bi-x"></i>
      </button>
    `;

    container.appendChild(toast);

    // Animasi slide in
    setTimeout(() => {
      toast.style.transform = 'translateX(0)';
      toast.style.opacity = '1';
    }, 20);

    // Auto remove setelah 7 detik
    setTimeout(() => {
      toast.style.transform = 'translateX(120%)';
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 400);
    }, 7000);
  }

  /**
   * Polling event soundbox dari server
   */
  async function pollSoundboxEvents() {
    try {
      const res = await fetch(`/admin/api/soundbox/poll?afterId=${lastSeenId}`);
      if (!res.ok) return;

      const data = await res.json();
      if (data.success && Array.isArray(data.events)) {
        if (!isInitialized) {
          // Inisialisasi awal: catat ID terbaru agar tidak membunyikan data lama
          if (data.events.length > 0) {
            lastSeenId = Math.max(...data.events.map(e => e.id));
          }
          isInitialized = true;
          return;
        }

        // Jika sudah aktif dan ada transaksi baru
        for (const ev of data.events) {
          if (ev.id > lastSeenId) {
            lastSeenId = ev.id;
            if (isEnabled) {
              audioQueue.push(ev);
              processAudioQueue();
            }
          }
        }
      }
    } catch (e) {
      // Silent error polling
    } finally {
      // Loop polling setiap 3.5 detik
      setTimeout(pollSoundboxEvents, 3500);
    }
  }

  /**
   * Update tampilan icon tombol di sidebar & UI
   */
  function updateSoundboxUI() {
    const btn = document.getElementById('btnSidebarSoundbox');
    const icon = document.getElementById('sidebarSoundboxIcon');
    if (btn && icon) {
      if (isEnabled) {
        icon.className = 'bi bi-volume-up-fill';
        icon.style.color = '#10b981';
        btn.setAttribute('title', 'Soundbox Kasir: Aktif (Membunyikan transaksi otomatis)');
        btn.classList.add('active');
      } else {
        icon.className = 'bi bi-volume-mute-fill';
        icon.style.color = '#94a3b8';
        btn.setAttribute('title', 'Soundbox Kasir: Nonaktif (Klik untuk hidupkan)');
        btn.classList.remove('active');
      }
    }

    // Update elemen Soundbox toggle pada halaman Voice Assistant jika ada
    const switchEl = document.getElementById('soundboxPageSwitch');
    if (switchEl) {
      switchEl.checked = isEnabled;
    }
    const statusPill = document.getElementById('soundboxStatusPill');
    if (statusPill) {
      statusPill.innerHTML = isEnabled 
        ? '<span style="width:8px;height:8px;border-radius:50%;background:#10b981;box-shadow:0 0 8px #10b981;display:inline-block;margin-right:6px;"></span> Aktif Siaga' 
        : '<span style="width:8px;height:8px;border-radius:50%;background:#64748b;display:inline-block;margin-right:6px;"></span> Nonaktif';
    }
  }

  /**
   * Toggle ON / OFF Soundbox Kasir
   */
  window.toggleAdminSoundbox = function() {
    isEnabled = !isEnabled;
    localStorage.setItem('admin_soundbox_enabled', isEnabled ? 'true' : 'false');
    updateSoundboxUI();

    if (isEnabled) {
      getAudioContext();
      playCashierChime().then(() => {
        playTtsAudio('Speaker kasir soundbox aktif.');
      });
    }
  };

  /**
   * Uji Suara Kasir (Tombol Test)
   */
  window.testSoundboxVoice = async function() {
    try {
      getAudioContext();
      const res = await fetch('/admin/api/soundbox/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: 50000 })
      });
      const data = await res.json();
      if (!data.success) {
        alert('Gagal tes soundbox: ' + (data.message || 'Error'));
      }
    } catch (e) {
      alert('Error: ' + e.message);
    }
  };

  // Jalankan saat DOM siap
  document.addEventListener('DOMContentLoaded', () => {
    updateSoundboxUI();
    // Buka audio context pada klik pertama di manapun di halaman
    const unlockAudio = () => {
      getAudioContext();
      document.removeEventListener('click', unlockAudio);
      document.removeEventListener('touchstart', unlockAudio);
    };
    document.addEventListener('click', unlockAudio);
    document.addEventListener('touchstart', unlockAudio);

    // Mulai polling
    pollSoundboxEvents();
  });

})();
