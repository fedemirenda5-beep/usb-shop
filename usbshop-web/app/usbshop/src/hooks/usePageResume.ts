'use client';

import { useEffect, useState } from 'react';

// Restart reads after suspension without remounting the page or losing a sale draft.
export function usePageResume() {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let awaySince: number | null = document.visibilityState === 'hidden' ? Date.now() : null;
    let lastResume = 0;
    let lastHeartbeat = Date.now();
    const resume = () => {
      if (document.visibilityState !== 'visible' || !navigator.onLine) return;
      const now = Date.now();
      if (now - lastResume < 1000) return;
      lastResume = now;
      lastHeartbeat = now;
      setRevision(value => value + 1);
    };
    const leave = () => { awaySince = Date.now(); };
    const returnToPage = () => {
      if (awaySince === null || document.visibilityState !== 'visible') return;
      const elapsed = Date.now() - awaySince;
      awaySince = null;
      if (elapsed >= 30_000) resume();
    };
    const visibility = () => {
      if (document.visibilityState === 'hidden') leave();
      else returnToPage();
    };
    // A PC can sleep while this tab remains visible, with no visibility event.
    const checkSleep = () => {
      const now = Date.now();
      const elapsed = now - lastHeartbeat;
      lastHeartbeat = now;
      if (elapsed >= 30_000) resume();
    };
    const focus = () => { returnToPage(); checkSleep(); };
    const heartbeat = window.setInterval(checkSleep, 15_000);
    const pageshow = (event: PageTransitionEvent) => { if (event.persisted) resume(); };
    window.addEventListener('blur', leave);
    window.addEventListener('focus', focus);
    window.addEventListener('online', resume);
    window.addEventListener('pageshow', pageshow);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('blur', leave);
      window.clearInterval(heartbeat);
      window.removeEventListener('focus', focus);
      window.removeEventListener('online', resume);
      window.removeEventListener('pageshow', pageshow);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, []);
  return revision;
}
