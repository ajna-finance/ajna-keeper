import fs from 'fs';
import path from 'path';
import { expect } from 'chai';

// Structural guard for the env-gated Tier-2 hybrid fork loop harness. Runs in
// the default suite (no network) so the expensive opt-in test cannot silently
// rot: it pins the env gate, the all-three-paths wiring, and the deliberate
// decision NOT to force-open the 1inch circuit (which would defeat the point).
describe('Hybrid fork loop harness', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../integration/hybrid-fork-loop.test.ts'),
    'utf8'
  );
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8')
  );

  it('keeps the command on an opt-in local Base fork path', () => {
    const script = packageJson.scripts['hybrid-fork-loop'];
    expect(script).to.include('RUN_HYBRID_FORK_LOOP=true');
    expect(script).to.include('HARDHAT_CHAIN_ID=8453');
    expect(script).to.include('FORK_NETWORK=base');
    expect(script).to.include(
      'npx hardhat test tests/integration/hybrid-fork-loop.test.ts'
    );
    expect(script).to.not.include('--network');
  });

  it('exposes a LI.FI-only fork proof command with callback execution enabled', () => {
    const script = packageJson.scripts['hybrid-lifi-fork-proof'];
    expect(script).to.include('RUN_HYBRID_FORK_LOOP=true');
    expect(script).to.include('HARDHAT_CHAIN_ID=8453');
    expect(script).to.include('FORK_NETWORK=base');
    expect(script).to.include('AJNA_AGENT_HYBRID_PATHS=lifi');
    expect(script).to.include('AJNA_AGENT_HYBRID_LIFI_CALLBACK_PROOF=true');
    expect(script).to.include(
      'npx hardhat test tests/integration/hybrid-fork-loop.test.ts'
    );
    expect(script).to.not.include('--network');
  });

  it('gates and skips cleanly like the other fork canaries', () => {
    expect(source).to.include("process.env.RUN_HYBRID_FORK_LOOP === 'true'");
    expect(source).to.include('this.skip();');
    expect(source).to.include("network.name !== 'hardhat'");
    expect(source).to.include("process.env.FORK_NETWORK ?? 'mainnet'");
    expect(source).to.include("process.env.HARDHAT_CHAIN_ID ?? '31337'");
    expect(source).to.include('function requireConfiguredBaseForkRpc');
    expect(source).to.include('Base fork RPC is required');
    expect(source).to.include('AJNA_AGENT_RPC_URL');
    expect(source).to.include('AJNA_RPC_URL_BASE');
    expect(source).to.include('BASE_RPC_URL');
    expect(source).to.include('ALCHEMY_API_KEY');
  });

  it('drives the real keeper discovery loop with all three providers enabled', () => {
    expect(source).to.include('handleDiscoveredTakeTarget');
    // Default competes all three paths; AJNA_AGENT_HYBRID_PATHS can restrict it
    // (e.g. to 'lifi') so a single provider can be forced as the executed path.
    expect(source).to.include("['oneinch', 'factory', 'lifi']");
    expect(source).to.include('allowedExternalTakePaths: paths');
    expect(source).to.include('AJNA_AGENT_HYBRID_PATHS');
    expect(source).to.include(
      "externalTakeRouteSelectionMode: 'maximize_profit'"
    );
    expect(source).to.include('validateRouteDeployments: true');
    expect(source).to.include("[LiquiditySource.LIFI]: '900000'");
    expect(source).to.include('validateAutoDiscoverConfig');
  });

  it('can pair hybrid LI.FI route selection with a fork-local callback execution proof', () => {
    expect(source).to.include('AJNA_AGENT_HYBRID_LIFI_CALLBACK_PROOF');
    expect(source).to.include('function runLifiCallbackExecutionProof');
    expect(source).to.include('MockAtomicSwapPool__factory');
    expect(source).to.include('MockPoolDeployer__factory');
    expect(source).to.include('fetchLifiTools');
    expect(source).to.include('fetchLifiQuote');
    expect(source).to.include('validateLifiQuote');
    expect(source).to.include(
      'hybrid LI.FI fork execution proof requires the default LI.FI API base URL'
    );
    expect(source).to.include('factory.takeWithAtomicSwap(');
    const proofIndex = source.indexOf(
      'await runLifiCallbackExecutionProof({ provider, owner: signer, lifi });'
    );
    const auctionIndex = source.indexOf(
      'await constructUnderwaterAuction({ pool, fixture });'
    );
    const discoveryIndex = source.indexOf(
      'stats = await handleDiscoveredTakeTarget({'
    );
    expect(proofIndex).to.be.greaterThan(-1);
    expect(auctionIndex).to.be.greaterThan(proofIndex);
    expect(discoveryIndex).to.be.greaterThan(auctionIndex);
  });

  it('deploys + registers all four takers and configures LI.FI allowlists', () => {
    expect(source).to.include('AjnaKeeperTakerFactory__factory');
    expect(source).to.include('UniswapV3KeeperTaker__factory');
    expect(source).to.include('SushiSwapKeeperTaker__factory');
    expect(source).to.include('CurveKeeperTaker__factory');
    expect(source).to.include('LifiKeeperTaker__factory');
    expect(source).to.include('factory.setTaker(LiquiditySource.LIFI');
    expect(source).to.include('function configureLifiTakerAllowlists');
    expect(source).to.include('setCallTarget');
    expect(source).to.include('setApprovalSpender');
    expect(source).to.include('setCallSelector');
  });

  it('requires a reviewed production keeper config with production dex.lifi', () => {
    expect(source).to.include('readConfigFile');
    expect(source).to.include('AJNA_AGENT_HYBRID_FORK_CONFIG');
    expect(source).to.include('function requireProductionLifi');
    expect(source).to.include('dex.lifi must be production mode');
  });

  it('does NOT force-open the 1inch circuit (real 1inch routes must compete)', () => {
    // run-fixture-keeper-harness force-opens the 1inch circuit so it never
    // fires; this harness must not, or the hybrid competition is a sham.
    expect(source).to.not.include('oneInchQuoteCircuits =');
    expect(source).to.not.include('failures: 99');
    expect(source).to.include('do NOT force-open the 1inch');
  });

  it('constructs a real liquidatable position and warps the auction down', () => {
    expect(source).to.include('function constructUnderwaterAuction');
    expect(source).to.include('depositQuoteToken');
    expect(source).to.include('drawDebt');
    expect(source).to.include('getLoansToKick');
    expect(source).to.include('poolKick(');
    expect(source).to.include('AJNA_AGENT_HYBRID_MAX_WARPS');
    expect(source).to.include('AJNA_AGENT_HYBRID_BORROWER_WHALE');
    expect(source).to.include('AJNA_AGENT_HYBRID_LENDER_WHALE');
  });

  it('defaults to dry-run and supports an opt-in live take', () => {
    expect(source).to.include(
      "process.env.AJNA_AGENT_HYBRID_FORK_LIVE_TAKE === 'true'"
    );
    expect(source).to.include('dryRun: !fixture.liveTake');
    expect(source).to.include('if (fixture.liveTake)');
  });
});
