import { Suspense } from 'react';
import { OAuthDoneClient } from './OAuthDoneClient';

export default function OAuthDonePage(): React.ReactElement {
  return (
    <Suspense fallback={<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', fontFamily: 'sans-serif' }}><p>Connecting&hellip;</p></div>}>
      <OAuthDoneClient />
    </Suspense>
  );
}
