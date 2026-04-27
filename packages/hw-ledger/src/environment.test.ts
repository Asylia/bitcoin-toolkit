import { describe, expect, it } from 'vitest';

import { recommendationFromEnvironment } from './environment';

describe('recommendationFromEnvironment', () => {
  it('marks an authorised WebHID Ledger as ready', () => {
    expect(
      recommendationFromEnvironment({
        webHidAvailable: true,
        browserFamily: 'chromium',
        previouslyAuthorised: true,
      }),
    ).toMatchObject({
      mode: 'ready_authorised',
      actionHint: 'Unlock the device and open the Bitcoin app.',
    });
  });

  it('routes unsupported browsers to install/switch guidance', () => {
    expect(
      recommendationFromEnvironment({
        webHidAvailable: false,
        browserFamily: 'safari',
        previouslyAuthorised: false,
      }),
    ).toMatchObject({
      mode: 'blocked_install_required',
      headline: 'Safari cannot talk to a Ledger',
    });
  });
});
