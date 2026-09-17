// Forwards the request's pathname + search string as headers so the root
// layout (which does not receive `searchParams`) can decide which probe
// scenario to render into <head>/<body>.
import { NextResponse } from 'next/server';

export function proxy(request) {
  const headers = new Headers(request.headers);
  headers.set('x-probe-pathname', request.nextUrl.pathname);
  headers.set('x-probe-search', request.nextUrl.search);
  return NextResponse.next({ request: { headers } });
}
