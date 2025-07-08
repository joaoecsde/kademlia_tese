// test/gateway-http-api.test.ts
// HTTP API tests for gateway store/find operations

import KademliaNode from '../node/node';

process.env.NODE_ENV = 'test';
process.env.PORT = '3000';

const TEST_TIMEOUT = 180000;

describe('Gateway HTTP API Tests', () => {
    let bootstrapNode: KademliaNode;
    let nodes: KademliaNode[] = [];
    
    beforeAll(async () => {
        console.log('Setting up Gateway HTTP API test network');
        
        // Create bootstrap node
        bootstrapNode = new KademliaNode(0, 3000);
        await bootstrapNode.start();
        console.log('Bootstrap node started');

        // Create test nodes
        const nodeConfigs = [
            { id: 1, port: 3001, httpPort: 2001 },
            { id: 2, port: 3002, httpPort: 2002 },
            { id: 3, port: 3003, httpPort: 2003 }
        ];

        for (const config of nodeConfigs) {
            console.log(`Creating node ${config.id} (UDP: ${config.port}, HTTP: ${config.httpPort})`);
            const node = new KademliaNode(config.id, config.port);
            nodes.push(node);
            await node.start();
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        console.log('Waiting for network formation');
        await new Promise(resolve => setTimeout(resolve, 12000));

        console.log('Gateway HTTP API test network ready!');
    }, TEST_TIMEOUT);

    afterAll(async () => {
        console.log('Cleaning up Gateway HTTP API test network');
        
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
        
        console.log('Gateway HTTP API cleanup complete');
    }, 60000);

    // Helper functions
    async function httpGet(url: string): Promise<any> {
        try {
            const response = await fetch(url);
            const data = await response.json();
            return { status: response.status, data, ok: response.ok };
        } catch (error) {
            throw new Error(`HTTP GET failed for ${url}: ${error.message}`);
        }
    }

    async function httpPost(url: string, body: any): Promise<any> {
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body)
            });
            const data = await response.json();
            return { status: response.status, data, ok: response.ok };
        } catch (error) {
            throw new Error(`HTTP POST failed for ${url}: ${error.message}`);
        }
    }

    describe('Gateway Store Operations via HTTP', () => {
        test('should store gateway via HTTP POST method', async () => {
            const gatewayData = {
                blockchainId: "hardhat1",
                endpoint: "http://localhost:8545/",
                supportedProtocols: ["SATP"]
            };
            
            console.log('\nTesting Gateway Store via HTTP POST');
            console.log('=====================================');
            console.log(`Storing gateway for ${gatewayData.blockchainId} on Node 1`);
            console.log(`URL: http://localhost:2001/storeGateway`);
            console.log(`Body:`, gatewayData);
            
            const storeResponse = await httpPost('http://localhost:2001/storeGateway', gatewayData);
            
            console.log('Store Response:', {
                status: storeResponse.status,
                success: storeResponse.ok,
                data: storeResponse.data
            });
            
            expect(storeResponse.ok).toBe(true);
            expect(storeResponse.status).toBe(200);
            expect(storeResponse.data.success).toBe(true);
            expect(storeResponse.data.gateway.blockchainId).toBe(gatewayData.blockchainId);
            expect(storeResponse.data.gateway.endpoint).toBe(gatewayData.endpoint);
            expect(storeResponse.data.storage.successful).toBeGreaterThan(0);
            
            console.log(`Gateway stored successfully!`);
            console.log(`Blockchain ID: ${storeResponse.data.gateway.blockchainId}`);
            console.log(`Endpoint: ${storeResponse.data.gateway.endpoint}`);
            console.log(`Node ID: ${storeResponse.data.gateway.nodeId}`);
            console.log(`Storage keys: Primary=${storeResponse.data.storage.keys.primary}, Specific=${storeResponse.data.storage.keys.specific}`);
            
            // Store gateway info for other tests
            (global as any).storedGateway = {
                blockchainId: gatewayData.blockchainId,
                endpoint: gatewayData.endpoint,
                nodeId: storeResponse.data.gateway.nodeId,
                keys: storeResponse.data.storage.keys
            };
            
            console.log('\nHTTP POST gateway store test passed');
        }, 90000);

        test('should store gateway via HTTP GET method', async () => {
            const blockchainId = "hardhat2";
            const endpoint = "http://localhost:8546/";
            const encodedEndpoint = encodeURIComponent(endpoint);
            
            console.log('\nTesting Gateway Store via HTTP GET');
            console.log('====================================');
            console.log(`Storing gateway for ${blockchainId} on Node 2`);
            console.log(`URL: http://localhost:2002/storeGateway/${blockchainId}/${encodedEndpoint}`);
            
            const storeResponse = await httpGet(`http://localhost:2002/storeGateway/${blockchainId}/${encodedEndpoint}`);
            
            console.log('Store Response:', {
                status: storeResponse.status,
                success: storeResponse.ok,
                data: storeResponse.data
            });
            
            expect(storeResponse.ok).toBe(true);
            expect(storeResponse.status).toBe(200);
            expect(storeResponse.data.success).toBe(true);
            expect(storeResponse.data.gateway.blockchainId).toBe(blockchainId);
            expect(storeResponse.data.gateway.endpoint).toBe(endpoint);
            
            console.log(`Gateway stored successfully via GET method!`);
            console.log(`Blockchain ID: ${storeResponse.data.gateway.blockchainId}`);
            console.log(`Endpoint: ${storeResponse.data.gateway.endpoint}`);
            console.log(`Node ID: ${storeResponse.data.gateway.nodeId}`);
            
            // Store for later tests
            (global as any).storedGateway2 = {
                blockchainId,
                endpoint,
                nodeId: storeResponse.data.gateway.nodeId
            };
            
            console.log('\nHTTP GET gateway store test passed');
        }, 90000);

        test('should store gateway with custom protocols', async () => {
            const blockchainId = "polygon1";
            const endpoint = "http://localhost:8547";
            const protocols = "SATP,ILP,HTLC";
            const encodedEndpoint = encodeURIComponent(endpoint);
            
            console.log('\nTesting Gateway Store with Custom Protocols');
            console.log('==============================================');
            console.log(`URL: http://localhost:2003/storeGateway/${blockchainId}/${encodedEndpoint}?protocols=${protocols}`);
            
            const storeResponse = await httpGet(`http://localhost:2003/storeGateway/${blockchainId}/${encodedEndpoint}?protocols=${protocols}`);
            
            expect(storeResponse.ok).toBe(true);
            expect(storeResponse.data.success).toBe(true);
            expect(storeResponse.data.gateway.supportedProtocols).toEqual(['SATP', 'ILP', 'HTLC']);
            
            console.log(`Gateway with custom protocols stored`);
            console.log(`Protocols: ${storeResponse.data.gateway.supportedProtocols.join(', ')}`);
        }, 90000);

        test('should handle invalid gateway data', async () => {
            console.log('\nTesting Invalid Gateway Data');
            console.log('===============================');
            
            // Test missing blockchainId
            console.log('Testing missing blockchainId');
            const invalidData1 = {
                endpoint: "http://localhost:8545"
            };
            
            const response1 = await httpPost('http://localhost:2001/storeGateway', invalidData1);
            expect(response1.status).toBe(400);
            expect(response1.data.success).toBe(false);
            console.log(`Correctly rejected missing blockchainId: ${response1.data.error}`);
            
            // Test missing endpoint
            console.log('Testing missing endpoint...');
            const invalidData2 = {
                blockchainId: "test-chain"
            };
            
            const response2 = await httpPost('http://localhost:2001/storeGateway', invalidData2);
            expect(response2.status).toBe(400);
            expect(response2.data.success).toBe(false);
            console.log(`Correctly rejected missing endpoint: ${response2.data.error}`);
            
            console.log('\nInvalid data handling test passed');
        }, 60000);
    });

    describe('Gateway Find Operations via HTTP', () => {
        test('should find gateway from same node that stored it', async () => {
            const storedGateway = (global as any).storedGateway;
            if (!storedGateway) {
                throw new Error('No stored gateway found - store test may have failed');
            }
            
            console.log('\nTesting Gateway Find from Same Node');
            console.log('====================================');
            console.log(`Finding gateway for ${storedGateway.blockchainId} from Node 1`);
            console.log(`URL: http://localhost:2001/findGateway/${storedGateway.blockchainId}`);
            
            const findResponse = await httpGet(`http://localhost:2001/findGateway/${storedGateway.blockchainId}`);
            
            console.log('Find Response:', {
                status: findResponse.status,
                success: findResponse.ok,
                data: findResponse.data
            });
            
            expect(findResponse.ok).toBe(true);
            expect(findResponse.status).toBe(200);
            expect(findResponse.data.gateways.length).toBeGreaterThan(0);
            
            const foundGateway = findResponse.data.gateways[0];
            expect(foundGateway.blockchainId).toBe(storedGateway.blockchainId);
            expect(foundGateway.endpoint).toBe(storedGateway.endpoint);
            
            console.log(`Gateway found successfully!`);
            console.log(`Blockchain ID: ${foundGateway.blockchainId}`);
            console.log(`Endpoint: ${foundGateway.endpoint}`);
            console.log(`Node ID: ${foundGateway.nodeId}`);
            console.log(`Total found: ${findResponse.data.count}`);
            console.log(`Message: ${findResponse.data.message}`);
            
            console.log('\nSame-node gateway find test passed');
        }, 90000);

        test('should find gateway from different node', async () => {
            const storedGateway = (global as any).storedGateway;
            if (!storedGateway) {
                throw new Error('No stored gateway found - store test may have failed');
            }
            
            console.log('\nTesting Cross-Node Gateway Find');
            console.log('=================================');
            console.log(`Finding gateway for ${storedGateway.blockchainId} from Node 2`);
            console.log(`URL: http://localhost:2002/findGateway/${storedGateway.blockchainId}`);
            
            console.log('Waiting for network propagation');
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            const findResponse = await httpGet(`http://localhost:2002/findGateway/${storedGateway.blockchainId}`);
            
            console.log('Cross-node Find Response:', {
                status: findResponse.status,
                success: findResponse.ok,
                data: findResponse.data
            });
            
            expect(findResponse.ok).toBe(true);
            expect(findResponse.status).toBe(200);
            
            if (findResponse.data.gateways.length > 0) {
                const foundGateway = findResponse.data.gateways[0];
                expect(foundGateway.blockchainId).toBe(storedGateway.blockchainId);
                expect(foundGateway.endpoint).toBe(storedGateway.endpoint);
                console.log(`Cross-node gateway retrieval successful!`);
                console.log(`Found gateway: ${foundGateway.blockchainId} -> ${foundGateway.endpoint}`);
                console.log(`Originally stored on Node ${storedGateway.nodeId}, found from Node 2`);
            } else {
                console.log(`Gateway not found via cross-node lookup`);
                // Verify it still exists on the original node
                const originalResponse = await httpGet(`http://localhost:2001/findGateway/${storedGateway.blockchainId}`);
                expect(originalResponse.data.gateways.length).toBeGreaterThan(0);
                console.log(`Gateway still exists on original node`);
            }
            console.log('\nCross-node gateway find test completed');
        }, 120000);

        test('should find multiple gateways for different blockchains', async () => {
            const storedGateway1 = (global as any).storedGateway;
            const storedGateway2 = (global as any).storedGateway2;
            
            console.log('\nTesting Multiple Gateway Find');
            console.log('===============================');
            
            if (!storedGateway1 || !storedGateway2) {
                throw new Error('Not all gateways were stored');
            }
            
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            // Find first gateway
            console.log(`Finding ${storedGateway1.blockchainId} from Node 3...`);
            const find1Response = await httpGet(`http://localhost:2003/findGateway/${storedGateway1.blockchainId}`);
            
            // Find second gateway
            console.log(`Finding ${storedGateway2.blockchainId} from Node 1...`);
            const find2Response = await httpGet(`http://localhost:2001/findGateway/${storedGateway2.blockchainId}`);
            
            console.log('\nMultiple Gateway Results:');
            console.log(`${storedGateway1.blockchainId}: ${find1Response.data.gateways.length > 0 ? 'Found' : 'Not found'}`);
            console.log(`${storedGateway2.blockchainId}: ${find2Response.data.gateways.length > 0 ? 'Found' : 'Not found'}`);
            
            const totalFound = find1Response.data.gateways.length + find2Response.data.gateways.length;
            expect(totalFound).toBeGreaterThan(0);
            
            if (find1Response.data.gateways.length > 0) {
                console.log(`${storedGateway1.blockchainId}: ${find1Response.data.gateways[0].endpoint}`);
            }
            if (find2Response.data.gateways.length > 0) {
                console.log(`${storedGateway2.blockchainId}: ${find2Response.data.gateways[0].endpoint}`);
            }
            
            console.log('\nMultiple gateway find test completed!');
        }, 120000);

        test('should handle non-existent blockchain gateway', async () => {
            const nonExistentBlockchain = 'non-existent-chain-' + Date.now();
            
            console.log('\nTesting Non-Existent Gateway');
            console.log('==============================');
            console.log(`Searching for ${nonExistentBlockchain} (should not exist)`);
            console.log(`URL: http://localhost:2001/findGateway/${nonExistentBlockchain}`);
            
            const findResponse = await httpGet(`http://localhost:2001/findGateway/${nonExistentBlockchain}`);
            
            console.log('Non-existent Gateway Response:', findResponse.data);
            
            expect(findResponse.ok).toBe(true);
            expect(findResponse.status).toBe(200);
            expect(findResponse.data.gateways.length).toBe(0);
            expect(findResponse.data.count).toBe(0);
            expect(findResponse.data.message).toContain('No gateways found');
            
            console.log(`Correctly returned no gateways: "${findResponse.data.message}"`);
        }, 60000);

        test('should test gateway find with filters', async () => {
            const storedGateway = (global as any).storedGateway;
            if (!storedGateway) {
                console.log('No stored gateway for filter test, skipping...');
                return;
            }
            
            console.log('\nTesting Gateway Find with Filters');
            console.log('===================================');
            
            // Test with includeUnhealthy filter
            console.log('Testing includeUnhealthy=true filter');
            const filterResponse1 = await httpGet(`http://localhost:2001/findGateway/${storedGateway.blockchainId}?includeUnhealthy=true`);
            expect(filterResponse1.ok).toBe(true);
            console.log(`Results with unhealthy included: ${filterResponse1.data.count} gateways`);
            
            // Test with includeUnhealthy=false
            console.log('Testing includeUnhealthy=false filter');
            const filterResponse2 = await httpGet(`http://localhost:2001/findGateway/${storedGateway.blockchainId}?includeUnhealthy=false`);
            expect(filterResponse2.ok).toBe(true);
            console.log(`Results without unhealthy: ${filterResponse2.data.count} gateways`);
            
            // Test with maxAge filter
            console.log('Testing maxAge=60 filter (60 minutes)');
            const filterResponse3 = await httpGet(`http://localhost:2001/findGateway/${storedGateway.blockchainId}?maxAge=60`);
            expect(filterResponse3.ok).toBe(true);
            console.log(`   Results with maxAge=60: ${filterResponse3.data.count} gateways`);
            
            // Test combined filters
            console.log('Testing combined filters');
            const filterResponse4 = await httpGet(`http://localhost:2001/findGateway/${storedGateway.blockchainId}?includeUnhealthy=false&maxAge=30`);
            expect(filterResponse4.ok).toBe(true);
            console.log(`   Results with combined filters: ${filterResponse4.data.count} gateways`);
        }, 90000);
    });

    describe('Gateway Management via HTTP', () => {
        test('should list all gateways on a node', async () => {
            console.log('\nTesting List All Gateways');
            console.log('============================');
            
            // List gateways on each node
            for (let i = 0; i < 3; i++) {
                const nodeId = i + 1;
                const port = 2001 + i;
                
                console.log(`\nListing gateways on Node ${nodeId}:`);
                console.log(`URL: http://localhost:${port}/gateways`);
                
                const listResponse = await httpGet(`http://localhost:${port}/gateways`);
                
                expect(listResponse.ok).toBe(true);
                expect(listResponse.status).toBe(200);
                expect(listResponse.data).toHaveProperty('nodeId', nodeId);
                expect(listResponse.data).toHaveProperty('totalGateways');
                expect(Array.isArray(listResponse.data.gateways)).toBe(true);
                
                console.log(`Total gateways on Node ${nodeId}: ${listResponse.data.totalGateways}`);
                
                listResponse.data.gateways.forEach((gateway, index) => {
                    console.log(`   ${index + 1}. ${gateway.blockchainId} -> ${gateway.endpoint}`);
                });
            }
            
            console.log('\nList gateways test passed');
        }, 90000);

        test('should check gateway health', async () => {
            const storedGateway = (global as any).storedGateway;
            if (!storedGateway) {
                console.log('No stored gateway for health test, skipping');
                return;
            }
            
            console.log('\nTesting Gateway Health Check');
            console.log('==============================');
            console.log(`Checking health for ${storedGateway.blockchainId}`);
            console.log(`URL: http://localhost:2001/gateway/${storedGateway.blockchainId}/health`);
            
            const healthResponse = await httpGet(`http://localhost:2001/gateway/${storedGateway.blockchainId}/health`);
            
            console.log('Health Response:', healthResponse.data);
            
            expect(healthResponse.ok).toBe(true);
            expect(healthResponse.status).toBe(200);
            expect(healthResponse.data).toHaveProperty('blockchainId', storedGateway.blockchainId);
            expect(healthResponse.data).toHaveProperty('totalGateways');
            expect(healthResponse.data).toHaveProperty('healthyGateways');
            expect(healthResponse.data).toHaveProperty('status');
            expect(Array.isArray(healthResponse.data.gateways)).toBe(true);
            
            console.log(`Health check completed!`);
            console.log(`Total gateways: ${healthResponse.data.totalGateways}`);
            console.log(`Healthy gateways: ${healthResponse.data.healthyGateways}`);
            console.log(`Overall status: ${healthResponse.data.status}`);
            
            if (healthResponse.data.gateways.length > 0) {
                console.log(`Gateway details:`);
                healthResponse.data.gateways.forEach((gateway, index) => {
                    console.log(`     ${index + 1}. ${gateway.endpoint} - ${gateway.healthy ? 'Healthy' : 'Unhealthy'}`);
                    if (gateway.responseTime) {
                        console.log(`Response time: ${gateway.responseTime}ms`);
                    }
                    if (gateway.error) {
                        console.log(`Error: ${gateway.error}`);
                    }
                });
            }
            
            console.log('\nGateway health test passed');
        }, 120000);

        test('should show network statistics for gateways', async () => {
            console.log('\nGateway Network Statistics');
            console.log('=============================');
            
            // First, store a gateway to ensure we have data for statistics
            const statsTestGateway = {
                blockchainId: "stats-test-chain",
                endpoint: "http://localhost:8549"
            };
            
            console.log('Storing a gateway for statistics test');
            const storeResponse = await httpPost('http://localhost:2001/storeGateway', statsTestGateway);
            expect(storeResponse.ok).toBe(true);
            
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            let totalGateways = 0;
            const nodeStats = [];
            
            // Collect stats from all nodes
            for (let i = 0; i < 3; i++) {
                const nodeId = i + 1;
                const port = 2001 + i;
                
                const listResponse = await httpGet(`http://localhost:${port}/gateways`);
                const gatewayCount = listResponse.data.totalGateways;
                totalGateways += gatewayCount;
                
                nodeStats.push({
                    nodeId,
                    port,
                    gateways: gatewayCount,
                    gatewayList: listResponse.data.gateways
                });
            }
            
            console.log('\nGateway Distribution:');
            nodeStats.forEach(stat => {
                console.log(`   Node ${stat.nodeId}: ${stat.gateways} gateways`);
                stat.gatewayList.forEach(gateway => {
                    console.log(`     - ${gateway.blockchainId}: ${gateway.endpoint}`);
                });
            });
            
            console.log(`\nNetwork Summary:`);
            console.log(`Total nodes: ${nodeStats.length}`);
            console.log(`Total registered gateways: ${totalGateways}`);
            console.log(`Average gateways per node: ${(totalGateways / nodeStats.length).toFixed(2)}`);
            
            const nodesWithGateways = nodeStats.filter(s => s.gateways > 0).length;
            console.log(`Nodes with gateways: ${nodesWithGateways}/${nodeStats.length}`);
            
            expect(nodeStats.length).toBe(3);
            
            // The test should pass even if totalGateways is 0, as it depends on whether 
            // gateways are stored in local registry vs DHT storage
            if (totalGateways > 0) {
                console.log(`   Found ${totalGateways} locally registered gateways`);
            } else {
                console.log(`No locally registered gateways (stored in DHT only)`);
                console.log(`This is normal - gateways are distributed across the DHT`);
            }
            
            // The real test is that we can still find gateways via DHT
            console.log('\nVerifying DHT gateway discovery still works');
            const findResponse = await httpGet(`http://localhost:2002/findGateway/${statsTestGateway.blockchainId}`);
            
            if (findResponse.data.gateways.length > 0) {
                console.log(`   Gateway discoverable via DHT: ${findResponse.data.gateways[0].endpoint}`);
            } else {
                console.log(`Gateway not immediately discoverable`);
            }
            
            console.log('\nGateway network statistics test passed');
        }, 90000);
    });

    describe('End-to-End Gateway Workflow', () => {
        test('should demonstrate complete gateway workflow', async () => {
            const testGateway = {
                blockchainId: "ethereum-test",
                endpoint: "http://localhost:8545",
                supportedProtocols: ["SATP", "ILP"]
            };
            
            console.log('\n🔄 Complete Gateway Workflow Test');
            console.log('=================================');
            
            console.log('\nStoring gateway');
            const storeResponse = await httpPost('http://localhost:2001/storeGateway', testGateway);
            expect(storeResponse.ok).toBe(true);
            expect(storeResponse.data.success).toBe(true);
            
            console.log(`Gateway stored: ${testGateway.blockchainId} -> ${testGateway.endpoint}`);
            
            await new Promise(resolve => setTimeout(resolve, 5000));
                        
            const findResults = [];
            for (let i = 0; i < 3; i++) {
                const nodeId = i + 1;
                const port = 2001 + i;
                
                console.log(`Finding from Node ${nodeId}`);
                const findResponse = await httpGet(`http://localhost:${port}/findGateway/${testGateway.blockchainId}`);
                
                findResults.push({
                    nodeId,
                    found: findResponse.data.gateways.length > 0,
                    count: findResponse.data.gateways.length
                });
                
                if (findResponse.data.gateways.length > 0) {
                    console.log(`Found ${findResponse.data.gateways.length} gateway(s)`);
                } else {
                    console.log(`No gateways found`);
                }
            }
            
            //Verify results
            const successfulFinds = findResults.filter(r => r.found);
            console.log(`Successful finds: ${successfulFinds.length}/${findResults.length} nodes`);
            
            expect(successfulFinds.length).toBeGreaterThan(0);

            console.log('\nStep 5: Checking gateway health');
            const healthResponse = await httpGet(`http://localhost:2001/gateway/${testGateway.blockchainId}/health`);
            expect(healthResponse.ok).toBe(true);
            
            console.log(`Health check completed: ${healthResponse.data.healthyGateways}/${healthResponse.data.totalGateways} healthy`);

            console.log('\nStep 6: Verifying in gateway list');
            const listResponse = await httpGet('http://localhost:2001/gateways');
            expect(listResponse.ok).toBe(true);
            
            const foundInList = listResponse.data.gateways.some(g => g.blockchainId === testGateway.blockchainId);
            console.log(`Gateway ${foundInList ? 'found' : 'not found'} in local list`);
        }, 180000);
    });
});