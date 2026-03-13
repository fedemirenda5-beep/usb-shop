import { NextRequest, NextResponse } from 'next/server';

const SESSION_COOKIE = 'usbshop_session';
const PROTECTED_ROUTES = ['/admin'];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Verificar si la ruta está protegida
  const isProtectedRoute = PROTECTED_ROUTES.some(route => 
    pathname.startsWith(route)
  );

  if (isProtectedRoute) {
    // Obtener cookie de sesión (httponly cookie)
    const sessionCookie = request.cookies.get(SESSION_COOKIE)?.value;

    if (!sessionCookie) {
      // Redirigir a login con return URL
      const loginUrl = new URL('/(auth)/login', request.url);
      loginUrl.searchParams.set('from', pathname);
      return NextResponse.redirect(loginUrl);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - api routes (backend)
     */
    '/((?!_next/static|_next/image|favicon.ico|api).*)',
  ],
};

