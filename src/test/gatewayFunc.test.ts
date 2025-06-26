import { GatewayInfo } from '../gateway/gateway';
import KademliaNode from '../node/node';
import { hashKeyAndmapToKeyspace } from '../utils/nodeUtils';

describe('Gateway System Tests', () => {
  let bootstrapNode: KademliaNode;
  let node1: KademliaNode;
  let node2: KademliaNode;
  
  beforeAll(async () => {
    console.log('Setting up test nodes...');
    
    bootstrapNode = new KademliaNode(0, 3000);
    node1 = new KademliaNode(100, 5000);
    node2 = new KademliaNode(200, 5001);
    
    console.log('Starting nodes...');
    await node1.start();
    await node2.start();
    
    console.log('Waiting for network stabilization...');
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    console.log(`Network ready - Node1: ${node1.table.getAllPeers().length} peers, Node2: ${node2.table.getAllPeers().length} peers`);
  }, 30000);
  
  afterAll(async () => {
    console.log('Quick cleanup...');
    
    // Quick cleanup - just close the critical resources
    const nodes = [bootstrapNode, node1, node2].filter(Boolean);
    
    nodes.forEach(node => {
      try {
        if (node?.stopGatewayHeartbeat) node.stopGatewayHeartbeat();
        if (node?.udpTransport?.server) node.udpTransport.server.close();
        if (node?.wsTransport?.server) node.wsTransport.server.close();
      } catch (e) {
        // Ignore cleanup errors
      }
    });
    
    await new Promise(resolve => setTimeout(resolve, 100));
  }, 3000); // Much shorter timeout
  
  test('✅ Gateway serialization works correctly', () => {
    const gateway = new GatewayInfo('ethereum', 123, 'http://gateway.example.com', ['SATP', 'ILP']);
    const serialized = gateway.serialize();
    const deserialized = GatewayInfo.deserialize(serialized);
    
    expect(deserialized.blockchainId).toBe('ethereum');
    expect(deserialized.nodeId).toBe(123);
    expect(deserialized.endpoint).toBe('http://gateway.example.com');
    expect(deserialized.supportedProtocols).toEqual(['SATP', 'ILP']);
  });
  
  test('✅ Local storage operations work', async () => {
    const key = hashKeyAndmapToKeyspace('test-storage-' + Date.now());
    const value = 'test-value-' + Date.now();
    
    await node1.table.nodeStore(key.toString(), value);
    const retrieved = await node1.table.findValue(key.toString());
    
    expect(retrieved).toBe(value);
  });
  
  test('✅ Gateway registration succeeds', async () => {
    const blockchainId = 'bitcoin-' + Date.now();
    
    const gateway = await node1.registerAsGateway(
      blockchainId,
      'http://bitcoin-gateway.local:8332',
      ['SATP']
    );
    
    expect(gateway.blockchainId).toBe(blockchainId);
    expect(gateway.nodeId).toBe(100);
    expect(gateway.endpoint).toBe('http://bitcoin-gateway.local:8332');
    expect(gateway.supportedProtocols).toContain('SATP');
  });
  
  test('✅ Gateway discovery finds local gateways', async () => {
    const blockchainId = 'ethereum-' + Date.now();
    
    await node1.registerAsGateway(blockchainId, 'http://eth-gateway.local', ['SATP']);
    
    const gateways = await node1.findGateways(blockchainId);
    
    expect(gateways.length).toBeGreaterThan(0);
    expect(gateways[0].blockchainId).toBe(blockchainId);
    expect(gateways[0].endpoint).toBe('http://eth-gateway.local');
  });
  
  test('✅ Network store operations work', async () => {
    const key = hashKeyAndmapToKeyspace('network-test-' + Date.now());
    const value = 'distributed-value-' + Date.now();
    
    const result = await node1.store(key, value);
    
    expect(result).toBeDefined();
    expect(Array.isArray(result)).toBe(true);
    expect(result!.length).toBeGreaterThan(0);
  });
  
  test('✅ Cross-node gateway discovery works', async () => {
    const blockchainId = 'solana-' + Date.now();
    
    // Register gateway on node1
    await node1.registerAsGateway(blockchainId, 'http://solana-gateway.local', ['SATP']);
    
    // Allow time for network propagation
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Search from node2
    const gateways = await node2.findGateways(blockchainId);
    
    expect(gateways.length).toBeGreaterThan(0);
    expect(gateways[0].blockchainId).toBe(blockchainId);
    
    console.log(`✅ Cross-node discovery successful: Found ${gateways.length} gateway(s) for ${blockchainId}`);
  }, 10000);
});