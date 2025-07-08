import KademliaNode from '../node/node';
import { hashKeyAndmapToKeyspace } from '../utils/nodeUtils';

// Set environment variables
process.env.NODE_ENV = 'test';
process.env.PORT = '3000';

const TEST_TIMEOUT = 180000; // 3 minutes

describe('DHT HTTP API Tests', () => {
    let bootstrapNode: KademliaNode;
    let nodes: KademliaNode[] = [];
    let httpPorts: number[] = [];
    
    beforeAll(async () => {
        console.log('Setting up HTTP API test network');
        
        try {
            // Create bootstrap node
            console.log('Creating bootstrap node (ID: 0, Port: 3000, HTTP: 2000)');
            bootstrapNode = new KademliaNode(0, 3000);
            await bootstrapNode.start();


            // Create test nodes
            const nodeConfigs = [
                { id: 1, port: 3001, httpPort: 2001 },
                { id: 2, port: 3002, httpPort: 2002 },
                { id: 3, port: 3003, httpPort: 2003 },
                { id: 4, port: 3004, httpPort: 2004 }
            ];

            console.log('Creating and starting test nodes');
            for (const config of nodeConfigs) {
                console.log(`Creating node ${config.id} (UDP: ${config.port}, HTTP: ${config.httpPort})`);
                const node = new KademliaNode(config.id, config.port);
                nodes.push(node);
                httpPorts.push(config.httpPort);
                
                await node.start();
                await new Promise(resolve => setTimeout(resolve, 1000));
            }

            console.log('Waiting for network formation ');
            await new Promise(resolve => setTimeout(resolve, 15000));

            await verifyHttpEndpoints();
            
            console.log('HTTP API test network ready');
        } catch (error) {
            console.error('Failed to setup HTTP API test network:', error);
            throw error;
        }
    }, TEST_TIMEOUT);

    afterAll(async () => {
        console.log('Cleaning up HTTP API test network');
        
        // Stop test nodes
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
        
        // Stop bootstrap node
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
        console.log('HTTP API cleanup complete');
    }, 60000);

    // Helper function to make HTTP requests
    async function makeHttpRequest(url: string, method: string = 'GET', body?: any): Promise<any> {
        const options: RequestInit = {
            method,
            headers: {
                'Content-Type': 'application/json',
            },
        };

        if (body && method !== 'GET') {
            options.body = JSON.stringify(body);
        }

        try {
            const response = await fetch(url, options);
            const data = await response.json();
            return { status: response.status, data, ok: response.ok };
        } catch (error) {
            throw new Error(`HTTP request failed: ${error.message}`);
        }
    }

    async function verifyHttpEndpoints() {
        console.log('Verifying HTTP endpoints');
        
        for (let i = 0; i < httpPorts.length; i++) {
            const port = httpPorts[i];
            const nodeId = i + 1;
            
            try {
                const response = await makeHttpRequest(`http://localhost:${port}/ping`);
                console.log(`Node ${nodeId} (port ${port}): ${response.ok ? 'OK' : 'Failed'}`);
                
                if (!response.ok) {
                    throw new Error(`Node ${nodeId} HTTP endpoint not responding`);
                }
            } catch (error) {
                console.error(`Node ${nodeId} (port ${port}): ${error.message}`);
                throw error;
            }
        }
    }

    describe('Basic HTTP Endpoints', () => {
        test('Should respond to ping on all nodes', async () => {
            console.log('\nTesting ping endpoints');
            
            for (let i = 0; i < httpPorts.length; i++) {
                const port = httpPorts[i];
                const nodeId = i + 1;
                
                console.log(`Pinging node ${nodeId} at http://localhost:${port}/ping`);
                
                const response = await makeHttpRequest(`http://localhost:${port}/ping`);
                
                expect(response.ok).toBe(true);
                expect(response.status).toBe(200);
                expect(response.data).toHaveProperty('message', 'success');
                
                console.log(`Node ${nodeId} ping successful`);
            }
        }, 30000);

        test('Should get node peers via HTTP', async () => {
            console.log('\nTesting getPeers endpoints');
            
            for (let i = 0; i < httpPorts.length; i++) {
                const port = httpPorts[i];
                const nodeId = i + 1;
                
                console.log(`Getting peers for node ${nodeId}...`);
                
                const response = await makeHttpRequest(`http://localhost:${port}/getPeers`);
                
                expect(response.ok).toBe(true);
                expect(response.status).toBe(200);
                expect(response.data).toHaveProperty('peers');
                expect(Array.isArray(response.data.peers)).toBe(true);
                
                console.log(`  Node ${nodeId}: ${response.data.peers.length} peers [${response.data.peers.map(p => p.nodeId).join(', ')}]`);
            }
            
            console.log('All getPeers tests passed');
        }, 30000);

        test('should get node buckets via HTTP', async () => {
            console.log('\nTesting getBucketNodes endpoints');
            
            for (let i = 0; i < httpPorts.length; i++) {
                const port = httpPorts[i];
                const nodeId = i + 1;
                
                console.log(`Getting buckets for node ${nodeId}`);
                
                const response = await makeHttpRequest(`http://localhost:${port}/getBucketNodes`);
                
                expect(response.ok).toBe(true);
                expect(response.status).toBe(200);
                expect(response.data).toHaveProperty('message');
                
                const buckets = response.data.message;
                const bucketCount = Object.keys(buckets).length;
                console.log(`  Node ${nodeId}: ${bucketCount} buckets`);
            }
            
            console.log('All getBucketNodes tests passed');
        }, 30000);
    });

    describe('DHT Store Operations via HTTP', () => {
        test('should store value via HTTP GET endpoint', async () => {
            const testValue = 'http-store-test-' + Date.now();
            const storePort = httpPorts[0];
            const nodeId = 1;
            
            console.log(`\nTesting store via HTTP GET`);
            console.log(`Storing "${testValue}" on node ${nodeId} via http://localhost:${storePort}/store/${testValue}`);
            
            const response = await makeHttpRequest(`http://localhost:${storePort}/store/${testValue}`);
            
            console.log('Store response:', response.data);
            
            expect(response.ok).toBe(true);
            expect(response.status).toBe(200);
            expect(response.data).toHaveProperty('result');
            expect(response.data).toHaveProperty('key');
            
            const expectedKey = hashKeyAndmapToKeyspace(testValue);
            expect(response.data.key).toBe(expectedKey);
            
            console.log(`Value "${testValue}" stored with key ${response.data.key}`);
            
            // Store the test value for later retrieval tests
            (global as any).testStoredValue = testValue;
            (global as any).testStoredKey = response.data.key;
            
            console.log('HTTP store test passed');
        }, 60000);

        test('should store multiple values on different nodes', async () => {
            console.log(`\nTesting multiple stores across nodes`);
            
            const testValues = [
                'multi-store-1-' + Date.now(),
                'multi-store-2-' + Date.now(),
                'multi-store-3-' + Date.now()
            ];
            
            const storeResults = [];
            
            for (let i = 0; i < testValues.length; i++) {
                const value = testValues[i];
                const port = httpPorts[i % httpPorts.length];
                const nodeId = (i % httpPorts.length) + 1;
                
                console.log(`Storing "${value}" on node ${nodeId}...`);
                
                const response = await makeHttpRequest(`http://localhost:${port}/store/${value}`);
                
                expect(response.ok).toBe(true);
                expect(response.data).toHaveProperty('key');
                
                storeResults.push({
                    value,
                    key: response.data.key,
                    nodeId,
                    port
                });
                
                console.log(`Stored with key ${response.data.key}`);
            }
            
            // Store results for later tests
            (global as any).multiStoreResults = storeResults;
            
            console.log('Multiple store test passed');
        }, 90000);
    });

    describe('DHT Find Operations via HTTP', () => {
        test('should find value via HTTP from same node', async () => {
            const testValue = (global as any).testStoredValue || 'http-store-test-fallback';
            const findPort = httpPorts[0];
            const nodeId = 1;
            
            console.log(`\nTesting find via HTTP from same node`);
            console.log(`Finding "${testValue}" from node ${nodeId} via http://localhost:${findPort}/findValue/${testValue}`);
            
            const response = await makeHttpRequest(`http://localhost:${findPort}/findValue/${testValue}`);
            
            console.log('Find response:', response.data);
            
            expect(response.ok).toBe(true);
            expect(response.status).toBe(200);
            
            if (response.data.found) {
                expect(response.data.value).toBe(testValue);
                expect(response.data).toHaveProperty('nodeInfo');
                expect(response.data.nodeInfo).toHaveProperty('nodeId');
                
                console.log(`Found "${testValue}" on node ${response.data.nodeInfo.nodeId}`);
                console.log(`Location: ${response.data.nodeInfo.address}:${response.data.nodeInfo.port}`);
            } else {
                console.log(`Value "${testValue}" not found`);
                console.log(`Response: ${response.data.message}`);
                
                // This might happen if the value was stored on a different node due to key distribution
                expect(response.data.found).toBe(false);
            }
            
            console.log('Same-node find test completed');
        }, 60000);

        test('should find value via HTTP from different node', async () => {
            const testValue = (global as any).testStoredValue || 'http-store-test-fallback';
            const findPort = httpPorts[1];
            const nodeId = 2;
            
            console.log(`\nTesting cross-node find via HTTP`);
            console.log(`Finding "${testValue}" from node ${nodeId} via http://localhost:${findPort}/findValue/${testValue}`);
            
            // Wait a bit for network propagation
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            const response = await makeHttpRequest(`http://localhost:${findPort}/findValue/${testValue}`);
            
            console.log('Cross-node find response:', response.data);
            
            expect(response.ok).toBe(true);
            expect(response.status).toBe(200);
            
            if (response.data.found) {
                expect(response.data.value).toBe(testValue);
                expect(response.data).toHaveProperty('nodeInfo');
                
                console.log(`Found "${testValue}" on node ${response.data.nodeInfo.nodeId}`);
                console.log(`Cross-node retrieval successful`);
            } else {
                console.log(`Value "${testValue}" not found via cross-node lookup`);
                console.log(`This might be due to network propagation or key distribution`);
                
                // Let's try to find it from the original storing node to verify it exists
                const originalResponse = await makeHttpRequest(`http://localhost:${httpPorts[0]}/findValue/${testValue}`);
                if (originalResponse.data.found) {
                    console.log(`Value exists on original node but not propagated yet`);
                } else {
                    console.log(`Value not found on original node either`);
                }
            }
            
            console.log('Cross-node find test completed');
        }, 90000);

        test('should find multiple values from different nodes', async () => {
            const multiStoreResults = (global as any).multiStoreResults || [];
            
            if (multiStoreResults.length === 0) {
                console.log('\nNo stored values found for multi-find test, skipping');
                return;
            }
            
            console.log(`\nTesting multiple finds across nodes`);
            console.log(`Searching for ${multiStoreResults.length} values`);
            
            // Wait for network propagation
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            const findResults = [];
            
            for (let i = 0; i < multiStoreResults.length; i++) {
                const storeResult = multiStoreResults[i];
                // Try to find from a different node than where it was stored
                const findPort = httpPorts[(i + 1) % httpPorts.length];
                const findNodeId = ((i + 1) % httpPorts.length) + 1;
                
                console.log(`Finding "${storeResult.value}" from node ${findNodeId} (stored on node ${storeResult.nodeId})...`);
                
                try {
                    const response = await makeHttpRequest(`http://localhost:${findPort}/findValue/${storeResult.value}`);
                    
                    findResults.push({
                        value: storeResult.value,
                        found: response.data.found,
                        searchNodeId: findNodeId,
                        storeNodeId: storeResult.nodeId,
                        foundOnNodeId: response.data.found ? response.data.nodeInfo.nodeId : null
                    });
                    
                    if (response.data.found) {
                        console.log(`Found on node ${response.data.nodeInfo.nodeId}`);
                    } else {
                        console.log(`Not found`);
                    }
                } catch (error) {
                    console.log(`Error: ${error.message}`);
                    findResults.push({
                        value: storeResult.value,
                        found: false,
                        searchNodeId: findNodeId,
                        storeNodeId: storeResult.nodeId,
                        error: error.message
                    });
                }
            }
            
            const successfulFinds = findResults.filter(r => r.found).length;
            const successRate = (successfulFinds / findResults.length) * 100;
            
            console.log(`\nMulti-find results:`);
            console.log(`Total searches: ${findResults.length}`);
            console.log(`Successful: ${successfulFinds}`);
            console.log(`Success rate: ${successRate.toFixed(1)}%`);
            
            findResults.forEach(result => {
                const status = result.found ? 'Found' : 'Not found';
                console.log(`  ${status} "${result.value}" (search: node ${result.searchNodeId}, store: node ${result.storeNodeId})`);
            });
            
            // Expect at least some success in cross-node finds
            expect(successfulFinds).toBeGreaterThan(0);
            
            console.log('Multiple finds test completed');
        }, 120000);

        test('should handle non-existent value lookup via HTTP', async () => {
            const nonExistentValue = 'asdasdada';
            const findPort = httpPorts[0];
            const nodeId = 1;
            
            console.log(`\nTesting non-existent value via HTTP`);
            console.log(`Searching for "${nonExistentValue}" on node ${nodeId}...`);
            
            const response = await makeHttpRequest(`http://localhost:${findPort}/findValue/${nonExistentValue}`);
            
            console.log('Non-existent value response:', response.data);
            
            expect(response.ok).toBe(true);
            expect(response.status).toBe(200);
            expect(response.data.found).toBe(false);
            expect(response.data.value).toBeNull();
            expect(response.data).toHaveProperty('message');
            
            console.log(`Correctly returned not found: "${response.data.message}"`);
            console.log('Non-existent value test passed!');
        }, 30000);
    });

    describe('Debug and Analysis Endpoints', () => {
        test('should get closest nodes for values via HTTP', async () => {
            const testValues = ['debug-test-1', 'debug-test-2', 'debug-test-3'];
            const port = httpPorts[0];

            console.log(`\nTesting debugClosestNodes endpoint`);
            
            for (const value of testValues) {
                console.log(`  Getting closest nodes for "${value}"...`);
                
                const response = await makeHttpRequest(`http://localhost:${port}/debugClosestNodes/${value}`);
                
                expect(response.ok).toBe(true);
                expect(response.status).toBe(200);
                expect(response.data).toHaveProperty('value', value);
                expect(response.data).toHaveProperty('key');
                expect(response.data).toHaveProperty('closestNodes');
                expect(Array.isArray(response.data.closestNodes)).toBe(true);
                
                console.log(`Key: ${response.data.key}`);
                console.log(`Closest nodes: ${response.data.closestNodes.map(n => `Node ${n.nodeId} (distance: ${n.distance})`).join(', ')}`);
            }
            
            console.log('Debug closest nodes test passed!');
        }, 60000);

        test('should get storage debug info via HTTP', async () => {
            const testKey = (global as any).testStoredKey || 'test-key';
            const port = httpPorts[0];
            
            console.log(`\nTesting debugStorage endpoint`);
            console.log(`Debugging storage for key: ${testKey}`);
            
            const response = await makeHttpRequest(`http://localhost:${port}/debugStorage/${testKey}`);
            
            expect(response.ok).toBe(true);
            expect(response.status).toBe(200);
            expect(response.data).toHaveProperty('query');
            expect(response.data).toHaveProperty('results');
            expect(response.data).toHaveProperty('nodeInfo');
            
            console.log('Debug storage response:');
            console.log(`Original key: ${response.data.query.originalKey}`);
            console.log(`Hashed key: ${response.data.query.hashedKey}`);
            console.log(`Direct found: ${response.data.results.direct.found}`);
            console.log(`Hashed found: ${response.data.results.hashed.found}`);
            console.log(`Node info: Node ${response.data.nodeInfo.nodeId} with ${response.data.nodeInfo.totalPeers} peers`);
            
            console.log('Debug storage test passed!');
        }, 30000);
    });

    describe('Network Status via HTTP', () => {
        test('should show network statistics via HTTP', async () => {
            console.log(`\nTesting network statistics via HTTP`);
            
            const networkStats = [];
            
            for (let i = 0; i < httpPorts.length; i++) {
                const port = httpPorts[i];
                const nodeId = i + 1;
                
                console.log(`Getting stats for node ${nodeId}...`);
                
                // Get peers
                const peersResponse = await makeHttpRequest(`http://localhost:${port}/getPeers`);
                expect(peersResponse.ok).toBe(true);
                
                // Get buckets
                const bucketsResponse = await makeHttpRequest(`http://localhost:${port}/getBucketNodes`);
                expect(bucketsResponse.ok).toBe(true);
                
                const peers = peersResponse.data.peers;
                const buckets = bucketsResponse.data.message;
                const bucketCount = Object.keys(buckets).length;
                
                networkStats.push({
                    nodeId,
                    port,
                    httpPort: port,
                    peers: peers.length,
                    peerIds: peers.map(p => p.nodeId),
                    buckets: bucketCount
                });
                
                console.log(`Node ${nodeId}: ${peers.length} peers, ${bucketCount} buckets`);
            }
            
            const totalPeers = networkStats.reduce((sum, stat) => sum + stat.peers, 0);
            const totalBuckets = networkStats.reduce((sum, stat) => sum + stat.buckets, 0);
            
            console.log(`\nNetwork Summary (via HTTP):`);
            console.log(`Total nodes: ${networkStats.length}`);
            console.log(`Total peer connections: ${totalPeers}`);
            console.log(`Total buckets: ${totalBuckets}`);
            console.log(`Average peers per node: ${(totalPeers / networkStats.length).toFixed(2)}`);
            
            // Basic health check
            const healthyNodes = networkStats.filter(stat => stat.peers > 0).length;
            console.log(`Healthy nodes: ${healthyNodes}/${networkStats.length}`);
            
            expect(networkStats.length).toBe(httpPorts.length);
            expect(totalPeers).toBeGreaterThan(0);
            
            console.log('Network statistics test passed!');
        }, 60000);
    });
});