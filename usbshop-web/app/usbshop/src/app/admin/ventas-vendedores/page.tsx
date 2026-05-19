'use client';

import { useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

export default function VentasVendedoresRedirectPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const params = new URLSearchParams();
    const period = searchParams.get('period');
    const seller = searchParams.get('seller');

    if (period) {
      params.set('period', period);
    }
    if (seller) {
      params.set('seller', seller);
    }

    router.replace(params.toString() ? `/admin/vendedores?${params.toString()}` : '/admin/vendedores');
  }, [router, searchParams]);

  return null;
}
