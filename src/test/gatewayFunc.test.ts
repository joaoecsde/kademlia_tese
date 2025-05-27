import KademliaNode from '../node/node';

describe('Gateway Functionality Summary', () => {
  let node1: KademliaNode;
  let node2: KademliaNode;
  
  beforeAll(async () => {
    // Create a minimal network
    node1 = new KademliaNode(0, 3000);
    node2 = new KademliaNode(1001, 3001);
    
    await node1.start();
    await node2.start();
    
    // Wait for network setup
    await new Promise(resolve => setTimeout(resolve, 2000));
  });
  
  afterAll(async () => {
    // Cleanup with timeout protection
    const cleanup = async () => {
      try {
        await Promise.race([
          Promise.all([node1.stop(), node2.stop()]),
          new Promise(resolve => setTimeout(resolve, 5000))
        ]);
      } catch (e) {
        // Ignore cleanup errors
      }
    };
    
    await cleanup();
  }, 10000);
  
  test('Gateway Registration and Discovery Works', async () => {
    // 1. Register a gateway
    const gatewayInfo = await node1.registerAsGateway(
      'ethereum',
      'http://localhost:8545',
      ['SATP', 'ILP']
    );
    
    expect(gatewayInfo).toMatchObject({
      blockchainId: 'ethereum',
      nodeId: 0,
      endpoint: 'http://localhost:8545',
      supportedProtocols: ['SATP', 'ILP']
    });
    
    // 2. Wait for DHT propagation
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // 3. Find the gateway from another node
    const foundGateways = await node2.findGateways('ethereum');
    
    expect(foundGateways.length).toBeGreaterThan(0);
    expect(foundGateways[0]).toMatchObject({
      blockchainId: 'ethereum',
      endpoint: 'http://localhost:8545'
    });
    
    console.log('✅ Gateway registration and discovery working!');
    console.log(`   Registered gateway: ${gatewayInfo.nodeId} for ${gatewayInfo.blockchainId}`);
    console.log(`   Found ${foundGateways.length} gateway(s) from different node`);
  });
  
  test('Multiple Gateways for Same Blockchain', async () => {
    const blockchainId = 'polygon';
    
    // Register both nodes as gateways
    await node1.registerAsGateway(blockchainId, 'http://localhost:8001', ['SATP']);
    await node2.registerAsGateway(blockchainId, 'http://localhost:8002', ['SATP']);
    
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Find all gateways
    const gateways = await node1.findGateways(blockchainId);
    
    expect(gateways.length).toBeGreaterThanOrEqual(2);
    
    const endpoints = gateways.map(g => g.endpoint).sort();
    expect(endpoints).toContain('http://localhost:8001');
    expect(endpoints).toContain('http://localhost:8002');
    
    console.log('✅ Multiple gateway support working!');
    console.log(`   Found ${gateways.length} gateways for ${blockchainId}`);
  });
  
  test('Gateway Data Persistence in DHT', async () => {
    const blockchainId = `bitcoin-${Date.now()}`;
    
    // Register gateway
    const originalGateway = await node1.registerAsGateway(
      blockchainId,
      'http://localhost:8332',
      ['SATP']
    );
    
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Clear local cache to ensure we're getting from DHT
    (node1 as any).registeredGateways.clear();
    
    // Find gateway again
    const foundGateways = await node1.findGateways(blockchainId);
    
    expect(foundGateways.length).toBe(1);
    expect(foundGateways[0].endpoint).toBe('http://localhost:8332');
    
    console.log('✅ Gateway data persists in DHT!');
  });
});