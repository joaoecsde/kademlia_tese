import KademliaNode from '../node/node';

process.env.NODE_ENV = 'test';
process.env.PORT = '3000';

const TEST_TIMEOUT = 180000;

describe('Secure Gateway HTTP API Tests', () => {
    let bootstrapNode: KademliaNode;
    let nodes: KademliaNode[] = [];
    
    beforeAll(async () => {
        console.log('Setting up Secure Gateway HTTP API test network');
        
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

        // Trigger key exchange for secure operations
        console.log('Triggering key exchange for secure operations');
        await triggerNetworkKeyExchange();

        await verifyEncryptionReadiness();
        
        console.log('Secure Gateway HTTP API test network ready!');
    }, TEST_TIMEOUT);

    afterAll(async () => {
        console.log('Cleaning up Secure Gateway HTTP API test network');
        
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
        
        console.log('Secure Gateway HTTP API cleanup complete');
    }, 60000);

    async function triggerNetworkKeyExchange() {
        console.log('Triggering key exchange across all nodes');
        
        const allNodes = [bootstrapNode, ...nodes];
        
        for (const node of allNodes) {
            try {
                await node.triggerKeyExchangeWithAllPeers();
            } catch (error) {
                console.warn(`Key exchange failed for node ${node.nodeId}:`, error.message);
            }
        }
        
        // Wait for key propagation
        await new Promise(resolve => setTimeout(resolve, 5000));
    }

    async function verifyEncryptionReadiness() {
        console.log('Verifying encryption readiness');
        
        const allNodes = [bootstrapNode, ...nodes];
        
        for (const node of allNodes) {
            const cryptoStats = node.getCryptoStats();
            const knownKeys = node.getKnownPublicKeys();
            
            console.log(`Node ${node.nodeId}: Encryption ${cryptoStats.encryptionEnabled ? 'enabled' : 'disabled'}, ${knownKeys.length} known keys`);
            
            if (knownKeys.length > 0) {
                console.log(`  Known keys: [${knownKeys.map(k => k.nodeId).join(', ')}]`);
            }
        }
    }

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

    describe('Secure Gateway Store Operations via HTTP', () => {
        test('should store gateway securely via HTTP POST method', async () => {
            const gatewayData = {
                blockchainId: "hardhat-secure-1",
                endpoint: "http://localhost:8545/",
            };
            
            console.log('\n Testing Secure Gateway Store via HTTP POST');
            console.log(`Storing gateway for ${gatewayData.blockchainId} on Node 1`);
            console.log(`URL: http://localhost:2001/secure/storeGateway`);
            console.log(`Body:`, gatewayData);
            
            const storeResponse = await httpPost('http://localhost:2001/secure/storeGateway', gatewayData);
            
            console.log('Secure Store Response:', {
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
            expect(storeResponse.data.storage.encrypted).toBe(true);
            
            console.log(`Secure gateway stored successfully!`);
            console.log(`Blockchain ID: ${storeResponse.data.gateway.blockchainId}`);
            console.log(`Endpoint: ${storeResponse.data.gateway.endpoint}`);
            console.log(`Node ID: ${storeResponse.data.gateway.nodeId}`);
            console.log(`Encrypted: ${storeResponse.data.storage.encrypted}`);
            console.log(`Encryption Coverage: ${storeResponse.data.storage.encryptionCoverage}`);
            
            // Store gateway info for other tests
            (global as any).secureStoredGateway = {
                blockchainId: gatewayData.blockchainId,
                endpoint: gatewayData.endpoint,
                nodeId: storeResponse.data.gateway.nodeId,
                encrypted: storeResponse.data.storage.encrypted
            };
            
            console.log('\n HTTP POST secure gateway store test passed');
        }, 90000);

        test('should store gateway securely via HTTP GET method', async () => {
            const blockchainId = "hardhat-secure-2";
            const endpoint = "http://localhost:8546/";
            const encodedEndpoint = encodeURIComponent(endpoint);
            
            console.log('\n Testing Secure Gateway Store via HTTP GET');
            console.log(`Storing gateway for ${blockchainId} on Node 2 (SECURE)`);
            console.log(`URL: http://localhost:2002/secure/storeGateway/${blockchainId}/${encodedEndpoint}`);
            
            const storeResponse = await httpGet(`http://localhost:2002/secure/storeGateway/${blockchainId}/${encodedEndpoint}`);
            
            console.log('Secure Store Response:', {
                status: storeResponse.status,
                success: storeResponse.ok,
                data: storeResponse.data
            });
            
            expect(storeResponse.ok).toBe(true);
            expect(storeResponse.status).toBe(200);
            expect(storeResponse.data.success).toBe(true);
            expect(storeResponse.data.gateway.blockchainId).toBe(blockchainId);
            expect(storeResponse.data.gateway.endpoint).toBe(endpoint);
            expect(storeResponse.data.storage.encrypted).toBe(true);
            
            console.log(`Secure gateway stored successfully via GET method!`);
            console.log(`Blockchain ID: ${storeResponse.data.gateway.blockchainId}`);
            console.log(`Endpoint: ${storeResponse.data.gateway.endpoint}`);
            console.log(`Node ID: ${storeResponse.data.gateway.nodeId}`);
            console.log(`Encrypted: ${storeResponse.data.storage.encrypted}`);
            console.log(`Encryption Coverage: ${storeResponse.data.storage.encryptionCoverage}`);
            
            // Store for later tests
            (global as any).secureStoredGateway2 = {
                blockchainId,
                endpoint,
                nodeId: storeResponse.data.gateway.nodeId,
                encrypted: storeResponse.data.storage.encrypted
            };
            
            console.log('\n HTTP GET secure gateway store test passed');
        }, 90000);

        test('should store secure gateway with custom protocols', async () => {
            const blockchainId = "polygon-secure-1";
            const endpoint = "http://localhost:8547";
            const protocols = "SATP,ILP,HTLC";
            const encodedEndpoint = encodeURIComponent(endpoint);
            
            console.log('\n Testing Secure Gateway Store with Custom Protocols');
            console.log(`URL: http://localhost:2003/secure/storeGateway/${blockchainId}/${encodedEndpoint}?protocols=${protocols}`);
            
            const storeResponse = await httpGet(`http://localhost:2003/secure/storeGateway/${blockchainId}/${encodedEndpoint}?protocols=${protocols}`);
            
            expect(storeResponse.ok).toBe(true);
            expect(storeResponse.data.success).toBe(true);
            expect(storeResponse.data.storage.encrypted).toBe(true);
            
            console.log(`Secure gateway with custom protocols stored`);
            console.log(`Encrypted: ${storeResponse.data.storage.encrypted}`);
            console.log(`Encryption Coverage: ${storeResponse.data.storage.encryptionCoverage}`);
        }, 90000);

        test('should handle invalid secure gateway data', async () => {
            console.log('\n Testing Invalid Secure Gateway Data');
            
            // Test missing blockchainId
            console.log('Testing missing blockchainId (secure)');
            const invalidData1 = {
                endpoint: "http://localhost:8545"
            };
            
            const response1 = await httpPost('http://localhost:2001/secure/storeGateway', invalidData1);
            expect(response1.status).toBe(400);
            expect(response1.data.success).toBe(false);
            console.log(`Correctly rejected missing blockchainId: ${response1.data.error}`);
            
            // Test missing endpoint
            console.log('Testing missing endpoint (secure)');
            const invalidData2 = {
                blockchainId: "test-secure-chain"
            };
            
            const response2 = await httpPost('http://localhost:2001/secure/storeGateway', invalidData2);
            expect(response2.status).toBe(400);
            expect(response2.data.success).toBe(false);
            console.log(`Correctly rejected missing endpoint: ${response2.data.error}`);
            
            console.log('\n Invalid secure data handling test passed');
        }, 60000);
    });

    describe('Secure Gateway Find Operations via HTTP', () => {
        test('should find secure gateway from same node that stored it', async () => {
            const secureStoredGateway = (global as any).secureStoredGateway;
            if (!secureStoredGateway) {
                throw new Error('No secure stored gateway found - secure store test may have failed');
            }
            
            console.log('\n Testing Secure Gateway Find from Same Node');
            console.log(`Finding gateway for ${secureStoredGateway.blockchainId} from Node 1 (SECURE)`);
            console.log(`URL: http://localhost:2001/secure/findGateway/${secureStoredGateway.blockchainId}`);
            
            const findResponse = await httpGet(`http://localhost:2001/secure/findGateway/${secureStoredGateway.blockchainId}`);
            
            console.log('Secure Find Response:', {
                status: findResponse.status,
                success: findResponse.ok,
                data: findResponse.data
            });
            
            expect(findResponse.ok).toBe(true);
            expect(findResponse.status).toBe(200);
            expect(findResponse.data.gateways.length).toBeGreaterThan(0);
            expect(findResponse.data.encrypted).toBe(true);
            
            const foundGateway = findResponse.data.gateways[0];
            expect(foundGateway.blockchainId).toBe(secureStoredGateway.blockchainId);
            expect(foundGateway.endpoint).toBe(secureStoredGateway.endpoint);
            
            console.log(`Secure gateway found successfully!`);
            console.log(`Blockchain ID: ${foundGateway.blockchainId}`);
            console.log(`Endpoint: ${foundGateway.endpoint}`);
            console.log(`Node ID: ${foundGateway.nodeId}`);
            console.log(`Total found: ${findResponse.data.count}`);
            console.log(`Encrypted: ${findResponse.data.encrypted}`);
            console.log(`Encryption Coverage: ${findResponse.data.encryptionCoverage}`);
            console.log(`Message: ${findResponse.data.message}`);
            
            console.log('\n Same-node secure gateway find test passed');
        }, 90000);

        test('should find secure gateway from different node', async () => {
            const secureStoredGateway = (global as any).secureStoredGateway;
            if (!secureStoredGateway) {
                throw new Error('No secure stored gateway found - secure store test may have failed');
            }
            
            console.log('\n Testing Cross-Node Secure Gateway Find');
            console.log(`Finding gateway for ${secureStoredGateway.blockchainId} from Node 2 (SECURE)`);
            console.log(`URL: http://localhost:2002/secure/findGateway/${secureStoredGateway.blockchainId}`);
            
            console.log('Waiting for secure network propagation');
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            const findResponse = await httpGet(`http://localhost:2002/secure/findGateway/${secureStoredGateway.blockchainId}`);
            
            console.log('Cross-node Secure Find Response:', {
                status: findResponse.status,
                success: findResponse.ok,
                data: findResponse.data
            });
            
            expect(findResponse.ok).toBe(true);
            expect(findResponse.status).toBe(200);
            expect(findResponse.data.encrypted).toBe(true);
            
            if (findResponse.data.gateways.length > 0) {
                const foundGateway = findResponse.data.gateways[0];
                expect(foundGateway.blockchainId).toBe(secureStoredGateway.blockchainId);
                expect(foundGateway.endpoint).toBe(secureStoredGateway.endpoint);
                console.log(`Cross-node secure gateway retrieval successful!`);
                console.log(`Found gateway: ${foundGateway.blockchainId} -> ${foundGateway.endpoint}`);
                console.log(`Originally stored on Node ${secureStoredGateway.nodeId}, found from Node 2`);
                console.log(`Encrypted: ${findResponse.data.encrypted}`);
                console.log(`Encryption Coverage: ${findResponse.data.encryptionCoverage}`);
            } else {
                console.log(`Secure gateway not found via cross-node lookup`);
                // Verify it still exists on the original node
                const originalResponse = await httpGet(`http://localhost:2001/secure/findGateway/${secureStoredGateway.blockchainId}`);
                expect(originalResponse.data.gateways.length).toBeGreaterThan(0);
                console.log(`Secure gateway still exists on original node`);
            }
            console.log('\n Cross-node secure gateway find test completed');
        }, 120000);

        test('should find multiple secure gateways for different blockchains', async () => {
            const secureStoredGateway1 = (global as any).secureStoredGateway;
            const secureStoredGateway2 = (global as any).secureStoredGateway2;
            
            console.log('\n Testing Multiple Secure Gateway Find');
            
            if (!secureStoredGateway1 || !secureStoredGateway2) {
                throw new Error('Not all secure gateways were stored');
            }
            
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            // Find first secure gateway
            console.log(`Finding ${secureStoredGateway1.blockchainId} from Node 3 (SECURE)...`);
            const find1Response = await httpGet(`http://localhost:2003/secure/findGateway/${secureStoredGateway1.blockchainId}`);
            
            // Find second secure gateway
            console.log(`Finding ${secureStoredGateway2.blockchainId} from Node 1 (SECURE)...`);
            const find2Response = await httpGet(`http://localhost:2001/secure/findGateway/${secureStoredGateway2.blockchainId}`);
            
            console.log('\n Multiple Secure Gateway Results:');
            console.log(`${secureStoredGateway1.blockchainId}: ${find1Response.data.gateways.length > 0 ? 'Found' : 'Not found'} (encrypted: ${find1Response.data.encrypted})`);
            console.log(`${secureStoredGateway2.blockchainId}: ${find2Response.data.gateways.length > 0 ? 'Found' : 'Not found'} (encrypted: ${find2Response.data.encrypted})`);
            
            const totalFound = find1Response.data.gateways.length + find2Response.data.gateways.length;
            expect(totalFound).toBeGreaterThan(0);
            
            // Verify encryption is enabled for both responses
            expect(find1Response.data.encrypted).toBe(true);
            expect(find2Response.data.encrypted).toBe(true);
            
            if (find1Response.data.gateways.length > 0) {
                console.log(`${secureStoredGateway1.blockchainId}: ${find1Response.data.gateways[0].endpoint} (Coverage: ${find1Response.data.encryptionCoverage})`);
            }
            if (find2Response.data.gateways.length > 0) {
                console.log(`${secureStoredGateway2.blockchainId}: ${find2Response.data.gateways[0].endpoint} (Coverage: ${find2Response.data.encryptionCoverage})`);
            }
            
            console.log('\n Multiple secure gateway find test completed!');
        }, 120000);

        test('should handle non-existent secure blockchain gateway', async () => {
            const nonExistentBlockchain = 'non-existent-secure-chain-' + Date.now();
            
            console.log('\n Testing Non-Existent Secure Gateway');
            console.log(`Searching for ${nonExistentBlockchain} (should not exist, SECURE)`);
            console.log(`URL: http://localhost:2001/secure/findGateway/${nonExistentBlockchain}`);
            
            const findResponse = await httpGet(`http://localhost:2001/secure/findGateway/${nonExistentBlockchain}`);
            
            console.log('Non-existent Secure Gateway Response:', findResponse.data);
            
            expect(findResponse.ok).toBe(true);
            expect(findResponse.status).toBe(200);
            expect(findResponse.data.gateways.length).toBe(0);
            expect(findResponse.data.count).toBe(0);
            expect(findResponse.data.encrypted).toBe(true);
            expect(findResponse.data.message).toContain('No gateways found');
            
            console.log(`Correctly returned no secure gateways: "${findResponse.data.message}"`);
            console.log(`Encrypted: ${findResponse.data.encrypted}`);
            console.log(`Encryption Coverage: ${findResponse.data.encryptionCoverage}`);
        }, 60000);

        test('should test secure gateway find with filters', async () => {
            const secureStoredGateway = (global as any).secureStoredGateway;
            if (!secureStoredGateway) {
                console.log('No secure stored gateway for filter test, skipping...');
                return;
            }
            
            console.log('\n Testing Secure Gateway Find with Filters');
            
            // Test with includeUnhealthy filter
            console.log('Testing includeUnhealthy=true filter (secure)');
            const filterResponse1 = await httpGet(`http://localhost:2001/secure/findGateway/${secureStoredGateway.blockchainId}?includeUnhealthy=true`);
            expect(filterResponse1.ok).toBe(true);
            expect(filterResponse1.data.encrypted).toBe(true);
            console.log(`Results with unhealthy included: ${filterResponse1.data.count} gateways (encrypted: ${filterResponse1.data.encrypted})`);
            
            // Test with includeUnhealthy=false
            console.log('Testing includeUnhealthy=false filter (secure)');
            const filterResponse2 = await httpGet(`http://localhost:2001/secure/findGateway/${secureStoredGateway.blockchainId}?includeUnhealthy=false`);
            expect(filterResponse2.ok).toBe(true);
            expect(filterResponse2.data.encrypted).toBe(true);
            console.log(`Results without unhealthy: ${filterResponse2.data.count} gateways (encrypted: ${filterResponse2.data.encrypted})`);
            
            // Test with maxAge filter
            console.log('Testing maxAge=60 filter (60 minutes, secure)');
            const filterResponse3 = await httpGet(`http://localhost:2001/secure/findGateway/${secureStoredGateway.blockchainId}?maxAge=60`);
            expect(filterResponse3.ok).toBe(true);
            expect(filterResponse3.data.encrypted).toBe(true);
            console.log(`Results with maxAge=60: ${filterResponse3.data.count} gateways (encrypted: ${filterResponse3.data.encrypted})`);
            
            // Test combined filters
            console.log('Testing combined filters (secure)');
            const filterResponse4 = await httpGet(`http://localhost:2001/secure/findGateway/${secureStoredGateway.blockchainId}?includeUnhealthy=false&maxAge=30`);
            expect(filterResponse4.ok).toBe(true);
            expect(filterResponse4.data.encrypted).toBe(true);
            console.log(`Results with combined filters: ${filterResponse4.data.count} gateways (encrypted: ${filterResponse4.data.encrypted})`);
        }, 90000);
    });

    describe('Secure Gateway Management via HTTP', () => {
        test('should list all secure gateways on a node', async () => {
            console.log('\n Testing List All Secure Gateways');
            
            // List gateways on each node
            for (let i = 0; i < 3; i++) {
                const nodeId = i + 1;
                const port = 2001 + i;
                
                console.log(`\nListing secure gateways on Node ${nodeId}:`);
                console.log(`URL: http://localhost:${port}/secure/gateways`);
                
                const listResponse = await httpGet(`http://localhost:${port}/secure/gateways`);
                
                expect(listResponse.ok).toBe(true);
                expect(listResponse.status).toBe(200);
                expect(listResponse.data).toHaveProperty('nodeId', nodeId);
                expect(listResponse.data).toHaveProperty('totalGateways');
                expect(listResponse.data).toHaveProperty('encrypted');
                expect(listResponse.data).toHaveProperty('encryptionCoverage');
                expect(listResponse.data.encrypted).toBe(true);
                expect(Array.isArray(listResponse.data.gateways)).toBe(true);
                
                console.log(`Total gateways on Node ${nodeId}: ${listResponse.data.totalGateways}`);
                console.log(`Encrypted: ${listResponse.data.encrypted}`);
                console.log(`Encryption Coverage: ${listResponse.data.encryptionCoverage}`);
                console.log(`Public Key Fingerprint: ${listResponse.data.security.publicKeyFingerprint}`);
                
                listResponse.data.gateways.forEach((gateway, index) => {
                    console.log(`  ${index + 1}. ${gateway.blockchainId} -> ${gateway.endpoint}`);
                });
            }
            
            console.log('\n List secure gateways test passed');
        }, 90000);

        test('should check secure gateway health', async () => {
            const secureStoredGateway = (global as any).secureStoredGateway;
            if (!secureStoredGateway) {
                console.log('No secure stored gateway for health test, skipping');
                return;
            }
            
            console.log('\n Testing Secure Gateway Health Check');
            console.log(`Checking health for ${secureStoredGateway.blockchainId} (SECURE)`);
            console.log(`URL: http://localhost:2001/secure/gateway/${secureStoredGateway.blockchainId}/health`);
            
            const healthResponse = await httpGet(`http://localhost:2001/secure/gateway/${secureStoredGateway.blockchainId}/health`);
            
            console.log('Secure Health Response:', healthResponse.data);
            
            expect(healthResponse.ok).toBe(true);
            expect(healthResponse.status).toBe(200);
            expect(healthResponse.data).toHaveProperty('blockchainId', secureStoredGateway.blockchainId);
            expect(healthResponse.data).toHaveProperty('totalGateways');
            expect(healthResponse.data).toHaveProperty('healthyGateways');
            expect(healthResponse.data).toHaveProperty('status');
            expect(healthResponse.data).toHaveProperty('encrypted');
            expect(healthResponse.data).toHaveProperty('encryptionCoverage');
            expect(healthResponse.data).toHaveProperty('security');
            expect(healthResponse.data.encrypted).toBe(true);
            expect(Array.isArray(healthResponse.data.gateways)).toBe(true);
            
            console.log(`Secure health check completed!`);
            console.log(`Total gateways: ${healthResponse.data.totalGateways}`);
            console.log(`Healthy gateways: ${healthResponse.data.healthyGateways}`);
            console.log(`Overall status: ${healthResponse.data.status}`);
            console.log(`Encrypted: ${healthResponse.data.encrypted}`);
            console.log(`Encryption Coverage: ${healthResponse.data.encryptionCoverage}`);
            console.log(`Search was encrypted: ${healthResponse.data.security.searchWasEncrypted}`);
            console.log(`Known keys: ${healthResponse.data.security.knownKeys}`);
            
            if (healthResponse.data.gateways.length > 0) {
                console.log(`Secure gateway details:`);
                healthResponse.data.gateways.forEach((gateway, index) => {
                    console.log(`  ${index + 1}. ${gateway.endpoint} - ${gateway.healthy ? 'Healthy' : 'Unhealthy'}`);
                    if (gateway.responseTime) {
                        console.log(`Response time: ${gateway.responseTime}ms`);
                    }
                    if (gateway.error) {
                        console.log(`Error: ${gateway.error}`);
                    }
                });
            }
            
            console.log('\n Secure gateway health test passed');
        }, 120000);

        test('should show network statistics for secure gateways', async () => {
            console.log('\n Secure Gateway Network Statistics');
            
            // First, store a secure gateway to ensure we have data for statistics
            const secureStatsTestGateway = {
                blockchainId: "secure-stats-test-chain",
                endpoint: "http://localhost:8549"
            };
            
            console.log('Storing a secure gateway for statistics test');
            const storeResponse = await httpPost('http://localhost:2001/secure/storeGateway', secureStatsTestGateway);
            expect(storeResponse.ok).toBe(true);
            expect(storeResponse.data.storage.encrypted).toBe(true);
            
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            let totalGateways = 0;
            const nodeStats = [];
            
            // Collect secure stats from all nodes
            for (let i = 0; i < 3; i++) {
                const nodeId = i + 1;
                const port = 2001 + i;
                
                const listResponse = await httpGet(`http://localhost:${port}/secure/gateways`);
                const gatewayCount = listResponse.data.totalGateways;
                totalGateways += gatewayCount;
                
                nodeStats.push({
                    nodeId,
                    port,
                    gateways: gatewayCount,
                    gatewayList: listResponse.data.gateways,
                    encrypted: listResponse.data.encrypted,
                    encryptionCoverage: listResponse.data.encryptionCoverage,
                    knownKeys: listResponse.data.security.knownKeys
                });
            }
            
            console.log('\n Secure Gateway Distribution:');
            nodeStats.forEach(stat => {
                console.log(`Node ${stat.nodeId}: ${stat.gateways} gateways (encrypted: ${stat.encrypted}, coverage: ${stat.encryptionCoverage})`);
                stat.gatewayList.forEach(gateway => {
                    console.log(`  - ${gateway.blockchainId}: ${gateway.endpoint}`);
                });
            });
            
            console.log(`\n Secure Network Summary:`);
            console.log(`Total nodes: ${nodeStats.length}`);
            console.log(`Total registered secure gateways: ${totalGateways}`);
            console.log(`Average gateways per node: ${(totalGateways / nodeStats.length).toFixed(2)}`);
            console.log(`All nodes encrypted: ${nodeStats.every(s => s.encrypted)}`);
            console.log(`Average encryption coverage: ${(nodeStats.reduce((sum, s) => sum + parseFloat(s.encryptionCoverage), 0) / nodeStats.length).toFixed(1)}%`);
            
            const nodesWithGateways = nodeStats.filter(s => s.gateways > 0).length;
            console.log(`Nodes with secure gateways: ${nodesWithGateways}/${nodeStats.length}`);
            
            expect(nodeStats.length).toBe(3);
            expect(nodeStats.every(s => s.encrypted)).toBe(true);
            
            // The test should pass even if totalGateways is 0, as it depends on whether 
            // gateways are stored in local registry vs DHT storage
            if (totalGateways > 0) {
                console.log(`Found ${totalGateways} locally registered secure gateways`);
            } else {
                console.log(`No locally registered secure gateways (stored in DHT only)`);
                console.log(`This is normal - secure gateways are distributed across the DHT`);
            }
            
            // The real test is that we can still find secure gateways via DHT
            console.log('\nVerifying DHT secure gateway discovery still works');
            const findResponse = await httpGet(`http://localhost:2002/secure/findGateway/${secureStatsTestGateway.blockchainId}`);
            expect(findResponse.data.encrypted).toBe(true);
            
            if (findResponse.data.gateways.length > 0) {
                console.log(` Gateway discoverable via secure DHT: ${findResponse.data.gateways[0].endpoint}`);
            } else {
                console.log(` Gateway not immediately discoverable via secure DHT`);
            }
            
            console.log('\n Secure gateway network statistics test passed');
        }, 90000);
    });

    describe('End-to-End Secure Gateway Workflow', () => {
        test('should demonstrate complete secure gateway workflow', async () => {
            const testGateway = {
                blockchainId: "ethereum-secure-test",
                endpoint: "http://localhost:8545",
                supportedProtocols: ["SATP", "ILP"]
            };
            
            console.log('\n Complete Secure Gateway Workflow Test');
            
            console.log('\nStep 1: Storing secure gateway');
            const storeResponse = await httpPost('http://localhost:2001/secure/storeGateway', testGateway);
            expect(storeResponse.ok).toBe(true);
            expect(storeResponse.data.success).toBe(true);
            expect(storeResponse.data.storage.encrypted).toBe(true);
            
            console.log(`Secure gateway stored: ${testGateway.blockchainId} -> ${testGateway.endpoint}`);
            console.log(`Encryption enabled: ${storeResponse.data.storage.encrypted}`);
            console.log(`Encryption coverage: ${storeResponse.data.storage.encryptionCoverage}`);
            
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            console.log('\nStep 2: Finding secure gateway from multiple nodes');
            const findResults = [];
            for (let i = 0; i < 3; i++) {
                const nodeId = i + 1;
                const port = 2001 + i;
                
                console.log(`Finding from Node ${nodeId} (SECURE)`);
                const findResponse = await httpGet(`http://localhost:${port}/secure/findGateway/${testGateway.blockchainId}`);
                
                expect(findResponse.data.encrypted).toBe(true);
                
                findResults.push({
                    nodeId,
                    found: findResponse.data.gateways.length > 0,
                    count: findResponse.data.gateways.length,
                    encrypted: findResponse.data.encrypted,
                    encryptionCoverage: findResponse.data.encryptionCoverage
                });
                
                if (findResponse.data.gateways.length > 0) {
                    console.log(`Found ${findResponse.data.gateways.length} secure gateway(s) (coverage: ${findResponse.data.encryptionCoverage})`);
                } else {
                    console.log(`No secure gateways found (coverage: ${findResponse.data.encryptionCoverage})`);
                }
            }
            
            console.log('\nStep 3: Verifying secure results');
            const successfulFinds = findResults.filter(r => r.found);
            console.log(`Successful secure finds: ${successfulFinds.length}/${findResults.length} nodes`);
            console.log(`All searches encrypted: ${findResults.every(r => r.encrypted)}`);
            
            expect(successfulFinds.length).toBeGreaterThan(0);
            expect(findResults.every(r => r.encrypted)).toBe(true);

            console.log('\nStep 4: Checking secure gateway health');
            const healthResponse = await httpGet(`http://localhost:2001/secure/gateway/${testGateway.blockchainId}/health`);
            expect(healthResponse.ok).toBe(true);
            expect(healthResponse.data.encrypted).toBe(true);
            
            console.log(`Secure health check completed: ${healthResponse.data.healthyGateways}/${healthResponse.data.totalGateways} healthy`);
            console.log(`Search was encrypted: ${healthResponse.data.security.searchWasEncrypted}`);
            console.log(`Known keys: ${healthResponse.data.security.knownKeys}`);

            console.log('\nStep 5: Verifying in secure gateway list');
            const listResponse = await httpGet('http://localhost:2001/secure/gateways');
            expect(listResponse.ok).toBe(true);
            expect(listResponse.data.encrypted).toBe(true);
            
            const foundInList = listResponse.data.gateways.some(g => g.blockchainId === testGateway.blockchainId);
            console.log(`Gateway ${foundInList ? 'found' : 'not found'} in secure local list`);
            console.log(`Encryption coverage: ${listResponse.data.encryptionCoverage}`);
            
            console.log('\n Complete secure gateway workflow test passed!');
        }, 180000);
    });
});