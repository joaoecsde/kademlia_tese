import KademliaNode from '../node/node';
import { hashKeyAndmapToKeyspace } from '../utils/nodeUtils';

const TEST_TIMEOUT = 180000; // 3 minutes

describe('Comprehensive DHT Operations Test Suite', () => {
    let bootstrapNode: KademliaNode;
    let nodes: KademliaNode[] = [];
    
    beforeAll(async () => {
        try {
            // Create bootstrap node
            console.log('Creating bootstrap node (ID: 0, Port: 3000)');
            bootstrapNode = new KademliaNode(0, 3000);
            await bootstrapNode.start();
            console.log('Bootstrap node started');

            // Create 5 test nodes for more comprehensive testing
            const nodeConfigs = [
                { id: 1, port: 3001 },
                { id: 2, port: 3002 },
                { id: 3, port: 3003 },
                { id: 4, port: 3004 },
                { id: 5, port: 3005 }
            ];

            console.log('Creating test nodes');
            for (const config of nodeConfigs) {
                console.log(`Creating node ${config.id} on port ${config.port}`);
                const node = new KademliaNode(config.id, config.port);
                nodes.push(node);
            }

            console.log('Starting test nodes');
            for (let i = 0; i < nodes.length; i++) {
                const node = nodes[i];
                await node.start();
                console.log(`Node ${node.nodeId} started`);
                await new Promise(resolve => setTimeout(resolve, 1000));
            }

            console.log('Waiting for peer discovery');
            await new Promise(resolve => setTimeout(resolve, 15000));

            await verifyNetworkConnectivity();
            
            console.log('Comprehensive test network ready');
        } catch (error) {
            console.error('Failed to setup comprehensive test network:', error);
            throw error;
        }
    }, TEST_TIMEOUT);

    afterAll(async () => {
        console.log(' Cleaning up comprehensive test network');
        
        for (let i = nodes.length - 1; i >= 0; i--) {
            const node = nodes[i];
            try {
                await Promise.race([
                    node.stop(),
                    new Promise(resolve => setTimeout(resolve, 5000))
                ]);
            } catch (error) {
                console.warn(`Error stopping node ${node.nodeId}:`, error.message);
            }
        }
        
        if (bootstrapNode) {
            try {
                await Promise.race([
                    bootstrapNode.stop(),
                    new Promise(resolve => setTimeout(resolve, 5000))
                ]);
            } catch (error) {
                console.warn('Error stopping bootstrap node:', error.message);
            }
        }
        
        await new Promise(resolve => setTimeout(resolve, 2000));
        console.log('Comprehensive cleanup complete');
    }, 60000);

    async function verifyNetworkConnectivity() {
        console.log('\n Network Connectivity Analysis:');
        
        const bootstrapPeers = bootstrapNode.table.getAllPeers();
        console.log(`Bootstrap Node (0): ${bootstrapPeers.length} peers [${bootstrapPeers.map(p => p.nodeId).join(', ')}]`);
        
        let totalConnections = 0;
        for (const node of nodes) {
            const peers = node.table.getAllPeers();
            const nonBootstrapPeers = peers.filter(p => p.nodeId !== 0);
            totalConnections += peers.length;
            console.log(`Node ${node.nodeId}: ${peers.length} total peers [${peers.map(p => p.nodeId).join(', ')}], ${nonBootstrapPeers.length} non-bootstrap`);
        }
        
        console.log(`Total network connections: ${totalConnections}`);
        return totalConnections;
    }

    describe('Basic Operations', () => {
        test('should store and retrieve on same node', async () => {
            const node = nodes[0];
            const testValue = 'basic-test-' + Date.now();
            const key = hashKeyAndmapToKeyspace(testValue);

            console.log(`\n Basic Test: Store/Find on node ${node.nodeId}`);
            console.log(`Value: "${testValue}", Key: ${key}`);

            await node.store(key, testValue);
            await new Promise(resolve => setTimeout(resolve, 1000));

            const result = await node.findValue(testValue);

            expect(result).toBeTruthy();
            expect(result.value).toBe(testValue);
            expect(result.nodeInfo.nodeId).toBe(node.nodeId);
            
        }, 60000);

        test('should handle non-existent values', async () => {
            const node = nodes[0];
            const nonExistentValue = 'non-existent-' + Date.now() + '-' + Math.random();

            console.log(`\n Testing non-existent value: "${nonExistentValue}"`);

            const result = await node.findValue(nonExistentValue);
            expect(result).toBeNull();
            
        }, 30000);
    });

    describe('Cross-Node Operations', () => {
        test('should store on one node and find from another', async () => {
            const storeNode = nodes[0];
            const findNode = nodes[1];
            const testValue = 'cross-node-' + Date.now();
            const key = hashKeyAndmapToKeyspace(testValue);

            console.log(`\n Cross-node test: Store on ${storeNode.nodeId}, Find from ${findNode.nodeId}`);
            console.log(`Value: "${testValue}", Key: ${key}`);

            // Show network state
            const storeNodePeers = storeNode.table.getAllPeers();
            const findNodePeers = findNode.table.getAllPeers();
            console.log(`Store node peers: [${storeNodePeers.map(p => p.nodeId).join(', ')}]`);
            console.log(`Find node peers: [${findNodePeers.map(p => p.nodeId).join(', ')}]`);

            // Show optimal storage locations
            const closestToKey = storeNode.debugClosestNodes(testValue);
            console.log('Optimal storage nodes:', closestToKey);

            // Store and retrieve
            await storeNode.store(key, testValue);
            console.log('Store completed');

            await new Promise(resolve => setTimeout(resolve, 3000));

            const result = await findNode.findValue(testValue);
            console.log('Find result:', result);

            expect(result).toBeTruthy();
            expect(result.value).toBe(testValue);
            
        }, 120000);

        test('should distribute data across multiple nodes', async () => {
            console.log(`\n Testing data distribution across ${nodes.length} nodes`);

            const testValues = [
                'distributed-1-' + Date.now(),
                'distributed-2-' + Date.now(),
                'distributed-3-' + Date.now(),
                'distributed-4-' + Date.now(),
                'distributed-5-' + Date.now()
            ];

            // Store each value on a different node
            console.log('Storing values across different nodes');
            for (let i = 0; i < testValues.length; i++) {
                const value = testValues[i];
                const storeNode = nodes[i];
                const key = hashKeyAndmapToKeyspace(value);
                
                console.log(` Storing "${value}" on node ${storeNode.nodeId} (key: ${key})`);
                await storeNode.store(key, value);
            }

            await new Promise(resolve => setTimeout(resolve, 5000));

            console.log('Retrieving values from different nodes');
            const results = [];
            for (let i = 0; i < testValues.length; i++) {
                const value = testValues[i];
                const searchNode = nodes[(i + 2) % nodes.length];
                
                console.log(`Finding "${value}" from node ${searchNode.nodeId}`);
                const result = await searchNode.findValue(value);
                results.push({ value, result, searchNode: searchNode.nodeId });
            }

            // Analyze results
            const successful = results.filter(r => r.result !== null);
            console.log(`\n Distribution Results: ${successful.length}/${testValues.length} successful`);
            
            successful.forEach(({ value, result, searchNode }) => {
                console.log(` "${value}" found by node ${searchNode} (stored on node ${result.nodeInfo.nodeId})`);
            });

            // Expect at least 80% success rate for distributed operations
            expect(successful.length).toBeGreaterThanOrEqual(Math.floor(testValues.length * 0.8));
            
        }, 180000);
    });

    describe('Data Integrity', () => {
        test('should preserve complex JSON data', async () => {
            const complexData = {
                id: Date.now(),
                name: "Complex Test Object",
                metadata: {
                    timestamp: new Date().toISOString(),
                    version: "1.0.0",
                    tags: ["test", "dht", "json"]
                },
                data: {
                    numbers: [1, 2, 3, 4, 5],
                    floats: [1.1, 2.2, 3.3],
                    booleans: [true, false, true],
                    nested: {
                        deep: {
                            value: "nested data"
                        }
                    }
                },
                special: "Special chars: àáâã äåæç èéêë"
            };

            const testValue = JSON.stringify(complexData);
            const node = nodes[0];
            const key = hashKeyAndmapToKeyspace(testValue);

            console.log(`\n Testing complex JSON (${testValue.length} chars)`);

            await node.store(key, testValue);
            await new Promise(resolve => setTimeout(resolve, 1000));

            const result = await node.findValue(testValue);

            expect(result).toBeTruthy();
            expect(result.value).toBe(testValue);

            // Verify JSON integrity
            const originalParsed = JSON.parse(testValue);
            const resultParsed = JSON.parse(result.value);
            expect(resultParsed).toEqual(originalParsed);

            console.log('Complex JSON integrity preserved!');
        }, 60000);

        test('should handle large values', async () => {
            const largeValue = 'Large test data: ' + 'x'.repeat(2000) + '-' + Date.now();
            const node = nodes[0];
            const key = hashKeyAndmapToKeyspace(largeValue);

            console.log(`\n Testing large value (${largeValue.length} chars)`);

            await node.store(key, largeValue);
            await new Promise(resolve => setTimeout(resolve, 2000));

            const result = await node.findValue(largeValue);

            expect(result).toBeTruthy();
            expect(result.value).toBe(largeValue);
            expect(result.value.length).toBe(largeValue.length);

            console.log('Large value handling passed!');
        }, 90000);
    });

    describe('Concurrent Operations', () => {
        test('should handle concurrent store operations', async () => {
            const concurrentValues = Array.from({ length: 8 }, (_, i) => 
                `concurrent-${i}-${Date.now()}`
            );

            console.log(`\n⚡ Testing ${concurrentValues.length} concurrent operations`);

            // Store all values concurrently
            const storePromises = concurrentValues.map((value, index) => {
                const node = nodes[index % nodes.length];
                const key = hashKeyAndmapToKeyspace(value);
                console.log(`  Storing "${value}" on node ${node.nodeId}`);
                return node.store(key, value);
            });

            console.log('Executing concurrent stores');
            await Promise.all(storePromises);
            console.log('All concurrent stores completed');

            await new Promise(resolve => setTimeout(resolve, 5000));

            // Try to find all values
            console.log('Finding all concurrent values');
            const findPromises = concurrentValues.map((value, index) => {
                const searchNode = nodes[(index + 1) % nodes.length];
                return searchNode.findValue(value).then(result => ({ value, result }));
            });

            const results = await Promise.all(findPromises);
            const foundCount = results.filter(({ result }) => result !== null).length;

            console.log(`Concurrent results: ${foundCount}/${concurrentValues.length} found`);
            
            // Expect at least 75% success for concurrent operations
            expect(foundCount).toBeGreaterThanOrEqual(Math.floor(concurrentValues.length * 0.75));
            
            console.log('Concurrent operations test passed');
        }, 180000);
    });

    describe('Network Analysis', () => {
        test('should show detailed network statistics', async () => {
            console.log(`\n Detailed Network Analysis:`);

            // Bootstrap node analysis
            const bootstrapPeers = bootstrapNode.table.getAllPeers();
            const bootstrapStatus = bootstrapNode.getStatus();
            console.log(`\nBootstrap Node (0):`);
            console.log(`Peers: ${bootstrapPeers.length} [${bootstrapPeers.map(p => p.nodeId).join(', ')}]`);
            console.log(`Buckets: ${bootstrapStatus.buckets}`);
            console.log(`HTTP Port: ${bootstrapStatus.httpPort}`);
            console.log(`UDP Port: ${bootstrapStatus.port}`);

            // Detailed node analysis
            let totalPeers = 0;
            let totalBuckets = 0;
            let nodeStats = [];

            for (const node of nodes) {
                const peers = node.table.getAllPeers();
                const buckets = node.table.getAllBucketsLen();
                const status = node.getStatus();
                
                totalPeers += peers.length;
                totalBuckets += buckets;

                const stats = {
                    nodeId: node.nodeId,
                    peers: peers.length,
                    peerIds: peers.map(p => p.nodeId),
                    buckets,
                    httpPort: status.httpPort,
                    udpPort: status.port
                };
                
                nodeStats.push(stats);

                console.log(`\nNode ${node.nodeId}:`);
                console.log(`Peers: ${stats.peers} [${stats.peerIds.join(', ')}]`);
                console.log(`Buckets: ${stats.buckets}`);
                console.log(`HTTP Port: ${stats.httpPort}`);
                console.log(`UDP Port: ${stats.udpPort}`);
            }

            // Network summary
            console.log(`\n Network Summary:`);
            console.log(`Total nodes: ${nodes.length + 1} (including bootstrap)`);
            console.log(`Total peer connections: ${totalPeers}`);
            console.log(`Total buckets: ${totalBuckets}`);
            console.log(`Average peers per node: ${(totalPeers / nodes.length).toFixed(2)}`);
            console.log(`Network connectivity: ${totalPeers > 0 ? 'Connected' : 'Disconnected'}`);

            // Health checks
            const healthyNodes = nodeStats.filter(s => s.peers > 0).length;
            console.log(`Healthy nodes: ${healthyNodes}/${nodes.length} (${((healthyNodes / nodes.length) * 100).toFixed(1)}%)`);

            // Basic assertions
            expect(nodes.length).toBeGreaterThan(0);
            expect(totalPeers).toBeGreaterThan(0);
            expect(healthyNodes).toBeGreaterThan(0);

            console.log('Network analysis completed');
        }, 30000);

        test('should demonstrate key distribution', async () => {
            console.log(`\n Key Distribution Analysis:`);

            const testValues = ['apple', 'banana', 'cherry', 'date', 'elderberry'];
            
            for (const value of testValues) {
                const key = hashKeyAndmapToKeyspace(value);
                const closestNodes = nodes[0].debugClosestNodes(value);
                
                console.log(`\nValue: "${value}"`);
                console.log(`Hash Key: ${key}`);
                console.log(`Optimal Storage Nodes:`);
                closestNodes.forEach((node, index) => {
                    console.log(`${index + 1}. Node ${node.nodeId} (distance: ${node.distance})`);
                });
            }

            // This test always passes - it's for analysis
            expect(testValues.length).toBe(5);
            console.log('\n Key distribution analysis completed');
        }, 30000);
    });
});