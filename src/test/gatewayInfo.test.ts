import { GatewayInfo } from '../gateway/gateway';

describe('GatewayInfo Class', () => {
  test('should create gateway info correctly', () => {
    const gateway = new GatewayInfo(
      'ethereum',
      1234,
      'http://localhost:8545',
      ['SATP', 'ILP']
    );
    
    expect(gateway.blockchainId).toBe('ethereum');
    expect(gateway.nodeId).toBe(1234);
    expect(gateway.endpoint).toBe('http://localhost:8545');
    expect(gateway.supportedProtocols).toEqual(['SATP', 'ILP']);
    expect(gateway.version).toBe(1);
    expect(gateway.timestamp).toBeLessThanOrEqual(Date.now());
  });
  
  test('should serialize and deserialize correctly', () => {
    const original = new GatewayInfo(
      'bitcoin',
      5678,
      'http://localhost:8332',
      ['SATP']
    );
    
    const serialized = original.serialize();
    expect(typeof serialized).toBe('string');
    
    const deserialized = GatewayInfo.deserialize(serialized);
    
    expect(deserialized.blockchainId).toBe(original.blockchainId);
    expect(deserialized.nodeId).toBe(original.nodeId);
    expect(deserialized.endpoint).toBe(original.endpoint);
    expect(deserialized.supportedProtocols).toEqual(original.supportedProtocols);
    expect(deserialized.timestamp).toBe(original.timestamp);
    expect(deserialized.version).toBe(original.version);
  });
});