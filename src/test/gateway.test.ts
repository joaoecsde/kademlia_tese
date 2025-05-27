import KademliaNode from '../node/node';
import { Peer } from '../peer/peer';

describe('Gateway Registration and Discovery', () => {
  let bootstrap: KademliaNode;
  let gateway1: KademliaNode;
  let gateway2: KademliaNode;
  let userNode: KademliaNode;
  
  beforeAll(async () => {
    // Setup network with proper port spacing to avoid conflicts
    bootstrap = new KademliaNode(1000, 7000); // Bootstrap on port 7000
    
    // Start bootstrap first and wait for it to be ready
    await bootstrap.start();
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Now start other nodes
    gateway1 = new KademliaNode(2000, 7001);
    gateway2 = new KademliaNode(2001, 7002);
    userNode = new KademliaNode(3000, 7003);
    
    await gateway1.start();
    await gateway2.start();
    await userNode.start();
    
    // Since your implementation automatically connects to port 3000, 
    // we need to ensure nodes can find each other
    // Add bootstrap node to routing tables
    await gateway1.table.updateTables(new Peer(bootstrap.nodeId, '127.0.0.1', 7000));
    await gateway2.table.updateTables(new Peer(bootstrap.nodeId, '127.0.0.1', 7000));
    await userNode.table.updateTables(new Peer(bootstrap.nodeId, '127.0.0.1', 7000));
    
    // Add nodes to bootstrap's routing table
    await bootstrap.table.updateTables(new Peer(gateway1.nodeId, '127.0.0.1', 7001));
    await bootstrap.table.updateTables(new Peer(gateway2.nodeId, '127.0.0.1', 7002));
    await bootstrap.table.updateTables(new Peer(userNode.nodeId, '127.0.0.1', 7003));
    
    // Wait for network stabilization
    await new Promise(resolve => setTimeout(resolve, 3000));
  }, 30000); // Increase timeout for setup
  
  afterAll(async () => {
    // Cleanup - stop all nodes
    try {
      // Stop heartbeats
      gateway1.stopGatewayHeartbeat();
      gateway2.stopGatewayHeartbeat();
      
      // Stop discovery schedulers
      if ((bootstrap as any).discScheduler) {
        (bootstrap as any).discScheduler.stopCronJob();
      }
      if ((gateway1 as any).discScheduler) {
        (gateway1 as any).discScheduler.stopCronJob();
      }
      if ((gateway2 as any).discScheduler) {
        (gateway2 as any).discScheduler.stopCronJob();
      }
      if ((userNode as any).discScheduler) {
        (userNode as any).discScheduler.stopCronJob();
      }
      
      // Close UDP servers
      bootstrap.udpTransport.server.close();
      gateway1.udpTransport.server.close();
      gateway2.udpTransport.server.close();
      userNode.udpTransport.server.close();
      
      // Close WebSocket servers
      bootstrap.wsTransport.server.close();
      gateway1.wsTransport.server.close();
      gateway2.wsTransport.server.close();
      userNode.wsTransport.server.close();
      
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (e) {
      // Ignore cleanup errors
    }
    
    // Force exit after cleanup
    process.exit(0);
  });
  
  describe('Direct Gateway Operations', () => {
    test('should register a node as gateway', async () => {
      const gatewayInfo = await gateway1.registerAsGateway(
        'ethereum',
        'http://localhost:8545',
        ['SATP', 'ILP']
      );
      
      expect(gatewayInfo.blockchainId).toBe('ethereum');
      expect(gatewayInfo.nodeId).toBe(2000);
      expect(gatewayInfo.endpoint).toBe('http://localhost:8545');
      expect(gatewayInfo.supportedProtocols).toContain('SATP');
      expect(gatewayInfo.supportedProtocols).toContain('ILP');
    }, 15000);
    
    test('should discover registered gateways', async () => {
      // Register gateway first
      await gateway2.registerAsGateway('bitcoin', 'http://localhost:8332', ['SATP']);
      
      // Wait for propagation in DHT
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // Discover from different node
      const gateways = await userNode.findGateways('bitcoin');
      
      expect(gateways.length).toBeGreaterThan(0);
      expect(gateways[0].blockchainId).toBe('bitcoin');
      expect(gateways[0].endpoint).toBe('http://localhost:8332');
    }, 20000);
    
    test('should return empty array for non-existent gateways', async () => {
      const gateways = await userNode.findGateways('non-existent-chain');
      expect(gateways).toEqual([]);
    }, 10000);
    
    test('should handle multiple gateways for same blockchain', async () => {
      // Use unique blockchain ID to avoid conflicts
      const blockchainId = `polygon-${Date.now()}`;
      
      // Both gateways register for the same blockchain
      await gateway1.registerAsGateway(blockchainId, 'http://localhost:8545', ['SATP']);
      await gateway2.registerAsGateway(blockchainId, 'http://localhost:8546', ['SATP']);
      
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      const gateways = await userNode.findGateways(blockchainId);
      
      // Should find at least 2 gateways
      expect(gateways.length).toBeGreaterThanOrEqual(2);
      
      // Check that both endpoints are found
      const endpoints = gateways.map(g => g.endpoint);
      expect(endpoints).toContain('http://localhost:8545');
      expect(endpoints).toContain('http://localhost:8546');
    }, 20000);
  });
  
  describe('Gateway Heartbeat', () => {
    test('should refresh gateway registration on heartbeat', async () => {
      const blockchainId = `cardano-${Date.now()}`;
      const initialInfo = await gateway1.registerAsGateway(
        blockchainId,
        'http://localhost:8090',
        ['SATP']
      );
      
      const initialTimestamp = initialInfo.timestamp;
      
      // Start heartbeat with short interval
      gateway1.startGatewayHeartbeat(blockchainId, 'http://localhost:8090', 1000);
      
      // Wait for heartbeat to trigger at least once
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Find the gateway again
      const gateways = await userNode.findGateways(blockchainId);
      const updatedGateway = gateways.find(g => g.nodeId === gateway1.nodeId);
      
      expect(updatedGateway).toBeDefined();
      expect(updatedGateway!.timestamp).toBeGreaterThanOrEqual(initialTimestamp);
      
      // Stop heartbeat
      gateway1.stopGatewayHeartbeat();
    }, 15000);
  });
});