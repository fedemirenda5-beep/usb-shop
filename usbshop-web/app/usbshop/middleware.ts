import { NextRequest, NextResponse } from 'next/server';

const SESSION_COOKIE = 'usbshop_session';
const PROTECTED_ROUTES = ['/admin'];

export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  // Verificar si la ruta está protegida
  const isProtectedRoute = PROTECTED_ROUTES.some(route => 
    pathname.startsWith(route)
  );

  if (isProtectedRoute) {
    // Obtener cookie de sesión (httponly cookie)
    const sessionCookie = request.cookies.get(SESSION_COOKIE)?.value;

    if (!sessionCookie) {
      // Redirigir a login con return URL
      const loginUrl = new URL('/login', request.url);
      loginUrl.searchParams.set('from', `${pathname}${search}`);
      return NextResponse.redirect(loginUrl);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/admin/:path*'],
};

