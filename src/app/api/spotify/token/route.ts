import { NextResponse } from 'next/server';
import { getAccessToken } from '../_lib';

export async function GET() {
  const token = await getAccessToken();
  if (!token) return NextResponse.json({ error: 'No token' }, { status: 404 });
  return NextResponse.json({ access_token: token });
}
