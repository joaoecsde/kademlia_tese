import * as fs from 'fs';
import * as path from 'path';
import KademliaNode from '../../node/node';

const TEST_TIMEOUT = 500000; // 5 minutes for larger networks

// Test different network sizes
const networkSizes = [5]; // Can extend to 20, 30+ for larger tests
const networkSize = networkSizes[0]; // --- IGNORE ---

interface GatewayScalabilityMetrics {
    nodeCount: number;
    networkSetupTime: number;
    avgGatewayStoreTime: number;
    avgGatewayDiscoveryTime: number;
    gatewayStoreSuccessRate: number;
    gatewayDiscoverySuccessRate: number;
    crossNodeDiscoveryRate: number;
    avgGatewaysPerNode: number;
    networkHealth: number;
    encryptionCoverage: number;
    timestamp: string;
    testDuration: number;
    minStoreTime?: number;
    maxStoreTime?: number;
    minDiscoveryTime?: number;
    maxDiscoveryTime?: number;
    totalGatewaysStored: number;
    totalGatewaysFound: number;
    memoryUsage?: NodeJS.MemoryUsage;
}

interface TestRunSummary {
    testRunId: string;
    startTime: string;
    endTime: string;
    totalDuration: number;
    nodeCountsAttempted: number[];
    successfulTests: number;
    failedTests: number;
    results: GatewayScalabilityMetrics[];
    environment: {
        nodeVersion: string;
        platform: string;
        arch: string;
        totalMemory: number;
    };
}

class TestResultsSaver {
    private resultsDir: string;
    private testRunId: string;
    private testStartTime: Date;

    constructor() {
        this.testRunId = `gateway-test-${Date.now()}`;
        this.testStartTime = new Date();
        this.resultsDir = path.join(process.cwd(), 'test-results', 'gateway-scalability');
        
        // Create results directory if it doesn't exist
        if (!fs.existsSync(this.resultsDir)) {
            fs.mkdirSync(this.resultsDir, { recursive: true });
        }
    }

    saveIndividualResult(metrics: GatewayScalabilityMetrics): void {
        const filename = `gateway-test-${metrics.nodeCount}nodes-${Date.now()}.json`;
        const filepath = path.join(this.resultsDir, filename);
        
        try {
            fs.writeFileSync(filepath, JSON.stringify(metrics, null, 2));
            console.log(`Individual test result saved to: ${filepath}`);
        } catch (error) {
            console.error(`Failed to save individual result:`, error);
        }
    }

    saveCSVResults(results: GatewayScalabilityMetrics[]): void {
        const csvFilename = `gateway-scalability-${networkSize}nodes-${this.testRunId}.csv`;
        const csvPath = path.join(this.resultsDir, csvFilename);
        
        try {
            const headers = [
                'NodeCount',
                'NetworkSetupTime(ms)',
                'AvgStoreTime(ms)',
                'AvgDiscoveryTime(ms)',
                'StoreSuccessRate(%)',
                'DiscoverySuccessRate(%)',
                'CrossNodeDiscoveryRate(%)',
                'GatewaysPerNode',
                'NetworkHealth(%)',
                'EncryptionCoverage(%)',
                'MinStoreTime(ms)',
                'MaxStoreTime(ms)',
                'MinDiscoveryTime(ms)',
                'MaxDiscoveryTime(ms)',
                'TotalGatewaysStored',
                'TotalGatewaysFound',
                'TestDuration(ms)',
                'MemoryUsed(MB)',
                'Timestamp'
            ].join(',');

            const csvData = results.map(r => [
                r.nodeCount,
                r.networkSetupTime,
                r.avgGatewayStoreTime.toFixed(1),
                r.avgGatewayDiscoveryTime.toFixed(1),
                (r.gatewayStoreSuccessRate * 100).toFixed(1),
                (r.gatewayDiscoverySuccessRate * 100).toFixed(1),
                (r.crossNodeDiscoveryRate * 100).toFixed(1),
                r.avgGatewaysPerNode.toFixed(2),
                (r.networkHealth * 100).toFixed(1),
                (r.encryptionCoverage * 100).toFixed(1),
                r.minStoreTime || 0,
                r.maxStoreTime || 0,
                r.minDiscoveryTime || 0,
                r.maxDiscoveryTime || 0,
                r.totalGatewaysStored,
                r.totalGatewaysFound,
                r.testDuration,
                r.memoryUsage ? (r.memoryUsage.heapUsed / 1024 / 1024).toFixed(1) : 'N/A',
                r.timestamp
            ].join(',')).join('\n');

            const csvContent = headers + '\n' + csvData;
            fs.writeFileSync(csvPath, csvContent);
            console.log(`CSV results saved to: ${csvPath}`);
        } catch (error) {
            console.error(`Failed to save CSV results:`, error);
        }
    }

    saveSummaryReport(results: GatewayScalabilityMetrics[], successfulTests: number, failedTests: number): void {
        const summary: TestRunSummary = {
            testRunId: this.testRunId,
            startTime: this.testStartTime.toISOString(),
            endTime: new Date().toISOString(),
            totalDuration: Date.now() - this.testStartTime.getTime(),
            nodeCountsAttempted: results.map(r => r.nodeCount),
            successfulTests,
            failedTests,
            results,
            environment: {
                nodeVersion: process.version,
                platform: process.platform,
                arch: process.arch,
                totalMemory: require('os').totalmem()
            }
        };

        const summaryFilename = `gateway-test-summary-${networkSize}nodes--${this.testRunId}.json`;
        const summaryPath = path.join(this.resultsDir, summaryFilename);
        
        try {
            fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
            console.log(`Test summary saved to: ${summaryPath}`);
        } catch (error) {
            console.error(`Failed to save test summary:`, error);
        }
    }

    generateMarkdownReport(results: GatewayScalabilityMetrics[]): void {
        const reportFilename = `gateway-scalability-report-${networkSize}nodes-${this.testRunId}.md`;
        const reportPath = path.join(this.resultsDir, reportFilename);
        
        let markdown = `# Gateway Scalability Test Report\n\n`;
        markdown += `**Test Run ID:** ${this.testRunId}\n`;
        markdown += `**Date:** ${new Date().toISOString().split('T')[0]}\n`;
        markdown += `**Duration:** ${((Date.now() - this.testStartTime.getTime()) / 1000 / 60).toFixed(1)} minutes\n\n`;
        
        markdown += `## Test Results Summary\n\n`;
        markdown += `| Nodes | Setup(s) | Store(ms) | Discovery(ms) | Store% | Discovery% | Cross% | Gw/Node | Health% | Encrypt% |\n`;
        markdown += `|-------|----------|-----------|---------------|--------|------------|--------|---------|---------|---------|\n`;
        
        results.forEach(result => {
            const setup = (result.networkSetupTime / 1000).toFixed(1);
            const store = result.avgGatewayStoreTime.toFixed(0);
            const discovery = result.avgGatewayDiscoveryTime.toFixed(0);
            const storeSuccess = (result.gatewayStoreSuccessRate * 100).toFixed(1);
            const discoverySuccess = (result.gatewayDiscoverySuccessRate * 100).toFixed(1);
            const crossSuccess = (result.crossNodeDiscoveryRate * 100).toFixed(1);
            const gwPerNode = result.avgGatewaysPerNode.toFixed(1);
            const health = (result.networkHealth * 100).toFixed(1);
            const encrypt = (result.encryptionCoverage * 100).toFixed(1);
            
            markdown += `| ${result.nodeCount} | ${setup} | ${store} | ${discovery} | ${storeSuccess} | ${discoverySuccess} | ${crossSuccess} | ${gwPerNode} | ${health} | ${encrypt} |\n`;
        });

        // Add performance analysis if we have multiple results
        if (results.length > 1) {
            markdown += `\n## Performance Analysis\n\n`;
            const firstResult = results[0];
            const lastResult = results[results.length - 1];
            
            const storeDegradation = firstResult.avgGatewayStoreTime > 0 ? 
                ((lastResult.avgGatewayStoreTime - firstResult.avgGatewayStoreTime) / firstResult.avgGatewayStoreTime) * 100 : 0;
            markdown += `- **Gateway store time change** from ${firstResult.nodeCount} to ${lastResult.nodeCount} nodes: ${storeDegradation.toFixed(1)}%\n`;
            
            const discoveryDegradation = firstResult.avgGatewayDiscoveryTime > 0 ?
                ((lastResult.avgGatewayDiscoveryTime - firstResult.avgGatewayDiscoveryTime) / firstResult.avgGatewayDiscoveryTime) * 100 : 0;
            markdown += `- **Gateway discovery time change**: ${discoveryDegradation.toFixed(1)}%\n`;
            
            const avgEfficiency = results.reduce((sum, r) => 
                sum + (r.gatewayStoreSuccessRate + r.gatewayDiscoverySuccessRate + r.crossNodeDiscoveryRate) / 3, 0) / results.length;
            markdown += `- **Average network efficiency**: ${(avgEfficiency * 100).toFixed(1)}%\n`;
        }

        markdown += `\n## Detailed Results\n\n`;
        results.forEach((result, index) => {
            markdown += `### ${result.nodeCount} Node Test\n\n`;
            markdown += `- **Setup Time**: ${(result.networkSetupTime / 1000).toFixed(1)}s\n`;
            markdown += `- **Average Store Time**: ${result.avgGatewayStoreTime.toFixed(1)}ms (range: ${result.minStoreTime || 0}-${result.maxStoreTime || 0}ms)\n`;
            markdown += `- **Average Discovery Time**: ${result.avgGatewayDiscoveryTime.toFixed(1)}ms (range: ${result.minDiscoveryTime || 0}-${result.maxDiscoveryTime || 0}ms)\n`;
            markdown += `- **Store Success Rate**: ${(result.gatewayStoreSuccessRate * 100).toFixed(1)}%\n`;
            markdown += `- **Discovery Success Rate**: ${(result.gatewayDiscoverySuccessRate * 100).toFixed(1)}%\n`;
            markdown += `- **Cross-Node Discovery Rate**: ${(result.crossNodeDiscoveryRate * 100).toFixed(1)}%\n`;
            markdown += `- **Network Health**: ${(result.networkHealth * 100).toFixed(1)}%\n`;
            markdown += `- **Encryption Coverage**: ${(result.encryptionCoverage * 100).toFixed(1)}%\n`;
            if (result.memoryUsage) {
                markdown += `- **Memory Usage**: ${(result.memoryUsage.heapUsed / 1024 / 1024).toFixed(1)}MB\n`;
            }
            markdown += `\n`;
        });

        try {
            fs.writeFileSync(reportPath, markdown);
            console.log(`Markdown report saved to: ${reportPath}`);
        } catch (error) {
            console.error(`Failed to save markdown report:`, error);
        }
    }

    listResultFiles(): string[] {
        try {
            return fs.readdirSync(this.resultsDir)
                .filter(file => file.startsWith('gateway-'))
                .map(file => path.join(this.resultsDir, file));
        } catch (error) {
            console.error('Failed to list result files:', error);
            return [];
        }
    }
}

describe('Gateway Scalability Test Suite', () => {
    const testResults: GatewayScalabilityMetrics[] = [];
    const resultsSaver = new TestResultsSaver();
    let successfulTests = 0;
    let failedTests = 0;

    networkSizes.forEach(nodeCount => {
        describe(`Gateway Operations with ${nodeCount} nodes`, () => {
            let bootstrapNode: KademliaNode;
            let nodes: KademliaNode[] = [];
            let setupStartTime: number;
            let setupEndTime: number;
            let storedGateways: Array<{blockchainId: string, endpoint: string, nodeId: number}> = [];
            let testStartTime: number;

            beforeAll(async () => {
                testStartTime = Date.now();
                setupStartTime = Date.now();
                
                try {
                    console.log(`\n=== Setting up gateway scalability test with ${nodeCount} nodes ===`);
                    
                    // Create bootstrap node
                    console.log('Creating bootstrap node (ID: 0, Port: 3000)');
                    bootstrapNode = new KademliaNode(0, 3000);
                    await bootstrapNode.start();
                    console.log('Bootstrap node started');

                    // Create test nodes
                    const nodeConfigs = Array.from({ length: nodeCount }, (_, i) => ({
                        id: i + 1,
                        port: 3001 + i
                    }));

                    console.log(`Creating ${nodeCount} test nodes`);

                    for (const config of nodeConfigs) {
                        console.log(`Creating node ${config.id} on port ${config.port}`);
                        const node = new KademliaNode(config.id, config.port);
                        nodes.push(node);
                        await node.start();
                        
                        console.log(`Node ${config.id} joined network`);
                        
                        // Small delay to prevent network congestion
                        await new Promise(resolve => setTimeout(resolve, 300));
                    }

                    console.log(`Waiting for network convergence...`);
                    await new Promise(resolve => setTimeout(resolve, Math.max(8000, nodeCount * 600)));

                    // Trigger encryption setup for secure gateway operations
                    console.log('Setting up encryption across network...');
                    await setupNetworkEncryption();

                    setupEndTime = Date.now();
                    
                    await verifyNetworkConnectivity(nodeCount);
                    console.log(`Gateway scalability network with ${nodeCount} nodes ready`);
                    
                } catch (error) {
                    console.error(`Failed to setup ${nodeCount}-node network:`, error);
                    failedTests++;
                    throw error;
                }
            }, TEST_TIMEOUT);

            afterAll(async () => {
                console.log(`Cleaning up ${nodeCount}-node gateway network`);
                
                // Stop all nodes
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
                console.log(`Cleanup complete for ${nodeCount}-node gateway network`);
            }, 100000);

            test(`should handle gateway storage operations efficiently with ${nodeCount} nodes`, async () => {
                console.log(`\nTesting gateway storage performance with ${nodeCount} nodes`);
                
                // Create diverse gateway test data
                const testGateways = Array.from({ length: Math.min(15, nodeCount * 2) }, (_, i) => ({
                    blockchainId: `blockchain-${nodeCount}n-${i}-${Date.now()}`,
                    endpoint: `http://localhost:${8545 + i}`,
                    nodeIndex: i % nodes.length
                }));

                const storeTimes: number[] = [];
                let storeSuccessCount = 0;

                console.log(`Storing ${testGateways.length} gateways across ${nodeCount} nodes...`);

                for (const gateway of testGateways) {
                    const storeNode = nodes[gateway.nodeIndex];
                    
                    try {
                        const storeStart = Date.now();
                        
                        // Use secure gateway storage
                        await storeNode.registerAsGatewaySecure(
                            gateway.blockchainId,
                            gateway.endpoint
                        );
                        
                        const storeEnd = Date.now();
                        
                        storeTimes.push(storeEnd - storeStart);
                        storeSuccessCount++;
                        
                        storedGateways.push({
                            blockchainId: gateway.blockchainId,
                            endpoint: gateway.endpoint,
                            nodeId: storeNode.nodeId
                        });
                        
                        console.log(`Stored gateway ${gateway.blockchainId} on node ${storeNode.nodeId} in ${storeEnd - storeStart}ms`);
                        
                    } catch (error) {
                        console.error(`Gateway storage failed for ${gateway.blockchainId}:`, error.message);
                    }
                    
                    // Brief delay to prevent overwhelming the network
                    await new Promise(resolve => setTimeout(resolve, 100));
                }

                const avgStoreTime = storeTimes.length > 0 ? 
                    storeTimes.reduce((a, b) => a + b, 0) / storeTimes.length : 0;
                const storeSuccessRate = storeSuccessCount / testGateways.length;

                console.log(`Gateway Storage Results:`);
                console.log(`- Total gateways: ${testGateways.length}`);
                console.log(`- Successfully stored: ${storeSuccessCount}`);
                console.log(`- Average store time: ${avgStoreTime.toFixed(1)}ms`);
                console.log(`- Success rate: ${(storeSuccessRate * 100).toFixed(1)}%`);
                console.log(`- Min time: ${storeTimes.length > 0 ? Math.min(...storeTimes) : 0}ms`);
                console.log(`- Max time: ${storeTimes.length > 0 ? Math.max(...storeTimes) : 0}ms`);

                // Store metrics for final comparison
                (global as any)[`storeMetrics_${nodeCount}`] = {
                    avgStoreTime,
                    storeSuccessRate,
                    totalGateways: testGateways.length,
                    successfulStores: storeSuccessCount,
                    minStoreTime: storeTimes.length > 0 ? Math.min(...storeTimes) : 0,
                    maxStoreTime: storeTimes.length > 0 ? Math.max(...storeTimes) : 0
                };

                // Expectations based on network size
                expect(storeSuccessRate).toBeGreaterThan(0.85); // 85% success rate
                expect(avgStoreTime).toBeLessThan(8000); // Under 8 seconds average
                
            }, TEST_TIMEOUT);

            test(`should handle gateway discovery operations efficiently with ${nodeCount} nodes`, async () => {
                console.log(`\nTesting gateway discovery performance with ${nodeCount} nodes`);

                // Wait for gateway propagation
                console.log('Waiting for gateway propagation across network...');
                await new Promise(resolve => setTimeout(resolve, Math.max(5000, nodeCount * 400)));

                const discoveryTimes: number[] = [];
                let discoverySuccessCount = 0;
                let crossNodeDiscoveries = 0;
                let totalCrossNodeAttempts = 0;
                let sameNodeDiscoveries = 0;
                let totalSameNodeAttempts = 0;

                console.log(`Attempting to discover ${storedGateways.length} gateways...`);

                for (const storedGateway of storedGateways) {
                    let gatewayFound = false;
                    
                    // Find the original storing node (same-node test)
                    const sameNode = nodes.find(n => n.nodeId === storedGateway.nodeId);
                    
                    // Find a different node (cross-node test)
                    const differentNode = nodes.find(n => n.nodeId !== storedGateway.nodeId);
                    
                    // Create test pairs - always test both same-node and cross-node if possible
                    const testPairs = [
                        { node: sameNode, isCrossNode: false, label: 'same-node' },
                        { node: differentNode, isCrossNode: true, label: 'cross-node' }
                    ];

                    for (const { node, isCrossNode, label } of testPairs) {
                        if (!node) {
                            console.warn(`No ${label} available for gateway ${storedGateway.blockchainId}`);
                            continue;
                        }
                        
                        // Count attempts
                        if (isCrossNode) {
                            totalCrossNodeAttempts++;
                        } else {
                            totalSameNodeAttempts++;
                        }

                        try {
                            const discoveryStart = Date.now();
                            
                            // Use secure gateway discovery
                            const foundGateways = await node.findGatewaysSecure(storedGateway.blockchainId);

                            const discoveryEnd = Date.now();
                            const discoveryTime = discoveryEnd - discoveryStart;
                            
                            discoveryTimes.push(discoveryTime);
                            
                            const found = foundGateways.some(g => {
                                const blockchainMatch = g.blockchainId === storedGateway.blockchainId;
                                const normalizeEndpoint = (url) => url.replace(/\/$/, ''); // Remove trailing slash
                                const endpointMatch = normalizeEndpoint(g.endpoint) === normalizeEndpoint(storedGateway.endpoint);
                                return blockchainMatch && endpointMatch;
                            });
                            
                            if (found) {
                                if (!gatewayFound) {
                                    gatewayFound = true; // Mark gateway as found (only count once per gateway)
                                }
                                
                                if (isCrossNode) {
                                    crossNodeDiscoveries++;
                                } else {
                                    sameNodeDiscoveries++;
                                }
                                
                                console.log(`Found gateway ${storedGateway.blockchainId} from node ${node.nodeId} in ${discoveryTime}ms (${label})`);
                            } else {
                                console.log(`Gateway ${storedGateway.blockchainId} NOT found from node ${node.nodeId} in ${discoveryTime}ms (${label})`);
                            }
                            
                        } catch (error) {
                            console.error(`Gateway discovery failed for ${storedGateway.blockchainId} from node ${node.nodeId} (${label}):`, error.message);
                        }
                        
                        // Brief delay between discoveries
                        await new Promise(resolve => setTimeout(resolve, 50));
                    }

                    if (gatewayFound) {
                        discoverySuccessCount++; // Only increment once per gateway
                    }
                }

                // Calculate metrics
                const avgDiscoveryTime = discoveryTimes.length > 0 ? 
                    discoveryTimes.reduce((a, b) => a + b, 0) / discoveryTimes.length : 0;
                
                const discoverySuccessRate = storedGateways.length > 0 ? 
                    discoverySuccessCount / storedGateways.length : 0; // Percentage of gateways found
                
                const crossNodeDiscoveryRate = totalCrossNodeAttempts > 0 ? 
                    crossNodeDiscoveries / totalCrossNodeAttempts : 0;
                
                const sameNodeDiscoveryRate = totalSameNodeAttempts > 0 ? 
                    sameNodeDiscoveries / totalSameNodeAttempts : 0;

                console.log(`Gateway Discovery Results:`);
                console.log(`- Total gateways to find: ${storedGateways.length}`);
                console.log(`- Successfully found (any node): ${discoverySuccessCount}`);
                console.log(`- Total discovery attempts: ${discoveryTimes.length}`);
                console.log(`- Average discovery time: ${avgDiscoveryTime.toFixed(1)}ms`);
                console.log(`- Gateway success rate: ${(discoverySuccessRate * 100).toFixed(1)}%`);
                console.log(`\n--- Same-Node Discovery ---`);
                console.log(`- Same-node attempts: ${totalSameNodeAttempts}`);
                console.log(`- Same-node discoveries: ${sameNodeDiscoveries}`);
                console.log(`- Same-node success rate: ${(sameNodeDiscoveryRate * 100).toFixed(1)}%`);
                console.log(`\n--- Cross-Node Discovery ---`);
                console.log(`- Cross-node attempts: ${totalCrossNodeAttempts}`);
                console.log(`- Cross-node discoveries: ${crossNodeDiscoveries}`);
                console.log(`- Cross-node success rate: ${(crossNodeDiscoveryRate * 100).toFixed(1)}%`);
                console.log(`\n--- Timing ---`);
                console.log(`- Min time: ${discoveryTimes.length > 0 ? Math.min(...discoveryTimes) : 0}ms`);
                console.log(`- Max time: ${discoveryTimes.length > 0 ? Math.max(...discoveryTimes) : 0}ms`);

                // Store metrics
                (global as any)[`discoveryMetrics_${nodeCount}`] = {
                    avgDiscoveryTime,
                    discoverySuccessRate,
                    crossNodeDiscoveryRate,
                    sameNodeDiscoveryRate, // New metric
                    totalGateways: storedGateways.length,
                    successfulDiscoveries: discoverySuccessCount,
                    totalAttempts: discoveryTimes.length,
                    crossNodeAttempts: totalCrossNodeAttempts,
                    sameNodeAttempts: totalSameNodeAttempts,
                    minDiscoveryTime: discoveryTimes.length > 0 ? Math.min(...discoveryTimes) : 0,
                    maxDiscoveryTime: discoveryTimes.length > 0 ? Math.max(...discoveryTimes) : 0
                };

                // Expectations - now more precise
                expect(discoverySuccessRate).toBeGreaterThan(0.60); // 60% of gateways found by at least one node
                expect(avgDiscoveryTime).toBeLessThan(15000); // Under 15 seconds
                expect(sameNodeDiscoveryRate).toBeGreaterThan(0.80); // Same-node should work most of the time
                expect(crossNodeDiscoveryRate).toBeGreaterThan(0.30); // Cross-node is the real test
                
            }, TEST_TIMEOUT);

            test(`should maintain gateway network health with ${nodeCount} nodes`, async () => {
                console.log(`\nAnalyzing gateway network health with ${nodeCount} nodes`);

                const networkHealth = await getNetworkHealth();
                const encryptionCoverage = await getNetworkEncryptionCoverage();
                const gatewayDistribution = await getGatewayDistribution();
                const memoryUsage = process.memoryUsage();

                console.log(`Gateway Network Health Analysis:`);
                console.log(`- Network health: ${(networkHealth * 100).toFixed(1)}%`);
                console.log(`- Encryption coverage: ${(encryptionCoverage * 100).toFixed(1)}%`);
                console.log(`- Total registered gateways: ${gatewayDistribution.totalGateways}`);
                console.log(`- Average gateways per node: ${gatewayDistribution.avgGatewaysPerNode.toFixed(1)}`);
                console.log(`- Nodes with gateways: ${gatewayDistribution.nodesWithGateways}/${nodeCount}`);
                console.log(`- Gateway distribution variance: ${gatewayDistribution.variance.toFixed(2)}`);
                console.log(`- Memory usage: ${(memoryUsage.heapUsed / 1024 / 1024).toFixed(1)}MB`);

                // Store comprehensive metrics
                const storeMetrics = (global as any)[`storeMetrics_${nodeCount}`] || {};
                const discoveryMetrics = (global as any)[`discoveryMetrics_${nodeCount}`] || {};
                const testDuration = Date.now() - testStartTime;

                const metrics: GatewayScalabilityMetrics = {
                    nodeCount,
                    networkSetupTime: setupEndTime - setupStartTime,
                    avgGatewayStoreTime: storeMetrics.avgStoreTime || 0,
                    avgGatewayDiscoveryTime: discoveryMetrics.avgDiscoveryTime || 0,
                    gatewayStoreSuccessRate: storeMetrics.storeSuccessRate || 0,
                    gatewayDiscoverySuccessRate: discoveryMetrics.discoverySuccessRate || 0,
                    crossNodeDiscoveryRate: discoveryMetrics.crossNodeDiscoveryRate || 0,
                    avgGatewaysPerNode: gatewayDistribution.avgGatewaysPerNode,
                    networkHealth,
                    encryptionCoverage,
                    timestamp: new Date().toISOString(),
                    testDuration,
                    minStoreTime: storeMetrics.minStoreTime,
                    maxStoreTime: storeMetrics.maxStoreTime,
                    minDiscoveryTime: discoveryMetrics.minDiscoveryTime,
                    maxDiscoveryTime: discoveryMetrics.maxDiscoveryTime,
                    totalGatewaysStored: storeMetrics.successfulStores || 0,
                    totalGatewaysFound: discoveryMetrics.successfulDiscoveries || 0,
                    memoryUsage
                };

                testResults.push(metrics);
                successfulTests++;

                // Save individual result immediately
                resultsSaver.saveIndividualResult(metrics);

                expect(networkHealth).toBeGreaterThan(0.75); // 75% health threshold
                expect(encryptionCoverage).toBeGreaterThan(0.80); // 80% encryption coverage
                expect(gatewayDistribution.nodesWithGateways).toBeGreaterThan(nodeCount * 0.3); // At least 30% nodes have gateways
            }, 90000);

            async function setupNetworkEncryption() {
                console.log('Triggering network-wide key exchange for secure gateway operations...');
                
                const allNodes = [bootstrapNode, ...nodes];
                
                for (const node of allNodes) {
                    try {
                        await node.triggerKeyExchangeWithAllPeers();
                    } catch (error) {
                        console.warn(`Key exchange failed for node ${node.nodeId}:`, error.message);
                    }
                }
                
                // Wait for key propagation
                await new Promise(resolve => setTimeout(resolve, 3000));
                
                console.log('Network encryption setup completed');
            }

            async function verifyNetworkConnectivity(expectedNodes: number) {
                console.log(`\nGateway Network Connectivity Check for ${expectedNodes} nodes:`);
                
                const bootstrapPeers = bootstrapNode.table.getAllPeers();
                console.log(`Bootstrap Node: ${bootstrapPeers.length} peers`);
                
                let totalConnections = 0;
                let connectedNodes = 0;
                let totalKnownKeys = 0;

                for (const node of nodes) {
                    const peers = node.table.getAllPeers();
                    const knownKeys = node.getKnownPublicKeys();
                    
                    totalConnections += peers.length;
                    totalKnownKeys += knownKeys.length;
                    
                    if (peers.length > 0) {
                        connectedNodes++;
                    }
                }
                
                console.log(`Connected nodes: ${connectedNodes}/${expectedNodes}`);
                console.log(`Total connections: ${totalConnections}`);
                console.log(`Total known encryption keys: ${totalKnownKeys}`);
                console.log(`Avg connections per node: ${(totalConnections / expectedNodes).toFixed(1)}`);
                console.log(`Avg keys per node: ${(totalKnownKeys / expectedNodes).toFixed(1)}`);
                
                return totalConnections;
            }

            async function getNetworkHealth(): Promise<number> {
                let healthyNodes = 0;
                const totalNodes = nodes.length;

                for (const node of nodes) {
                    const peers = node.table.getAllPeers();
                    if (peers.length > 0) {
                        healthyNodes++;
                    }
                }

                return totalNodes > 0 ? healthyNodes / totalNodes : 0;
            }

            async function getNetworkEncryptionCoverage(): Promise<number> {
                let nodesWithKeys = 0;
                const totalNodes = nodes.length;

                for (const node of nodes) {
                    const knownKeys = node.getKnownPublicKeys();
                    if (knownKeys.length > 0) {
                        nodesWithKeys++;
                    }
                }

                return totalNodes > 0 ? nodesWithKeys / totalNodes : 0;
            }

            async function getGatewayDistribution() {
                const gatewayDistribution: number[] = [];
                let totalGateways = 0;
                let nodesWithGateways = 0;

                for (const node of nodes) {
                    const registeredGateways = node.getRegisteredGateways();
                    const gatewayCount = registeredGateways.size;
                    
                    gatewayDistribution.push(gatewayCount);
                    totalGateways += gatewayCount;
                    
                    if (gatewayCount > 0) {
                        nodesWithGateways++;
                    }
                }

                const avgGatewaysPerNode = nodes.length > 0 ? totalGateways / nodes.length : 0;
                
                // Calculate variance
                const variance = gatewayDistribution.length > 0 ? 
                    gatewayDistribution.reduce((acc, count) => 
                        acc + Math.pow(count - avgGatewaysPerNode, 2), 0) / gatewayDistribution.length : 0;

                return {
                    totalGateways,
                    avgGatewaysPerNode,
                    nodesWithGateways,
                    variance,
                    distribution: gatewayDistribution
                };
            }
        });
    });

    afterAll(() => {
        // Save all results in multiple formats
        console.log('\n=== Saving Test Results ===');
        
        // Save CSV format
        resultsSaver.saveCSVResults(testResults);
        
        // Save comprehensive JSON summary
        resultsSaver.saveSummaryReport(testResults, successfulTests, failedTests);
        
        // Generate markdown report
        resultsSaver.generateMarkdownReport(testResults);
        
        // List all saved files
        const savedFiles = resultsSaver.listResultFiles();
        console.log(`\nSaved result files:`);
        savedFiles.forEach(file => console.log(`- ${file}`));
        
        // Print console summary (existing functionality)
        console.log('\n=== GATEWAY SCALABILITY TEST SUMMARY ===\n');
        console.log('Nodes | Setup(s) | Store(ms) | Discovery(ms) | Store% | Discovery% | Cross% | Gw/Node | Health% | Encrypt%');
        console.log('------|----------|-----------|---------------|--------|------------|--------|---------|---------|----------');
        
        testResults.forEach(result => {
            const setup = (result.networkSetupTime / 1000).toFixed(1);
            const store = result.avgGatewayStoreTime.toFixed(0);
            const discovery = result.avgGatewayDiscoveryTime.toFixed(0);
            const storeSuccess = (result.gatewayStoreSuccessRate * 100).toFixed(1);
            const discoverySuccess = (result.gatewayDiscoverySuccessRate * 100).toFixed(1);
            const crossSuccess = (result.crossNodeDiscoveryRate * 100).toFixed(1);
            const gwPerNode = result.avgGatewaysPerNode.toFixed(1);
            const health = (result.networkHealth * 100).toFixed(1);
            const encrypt = (result.encryptionCoverage * 100).toFixed(1);
            
            console.log(`${result.nodeCount.toString().padEnd(5)} | ${setup.padEnd(8)} | ${store.padEnd(9)} | ${discovery.padEnd(13)} | ${storeSuccess.padEnd(6)} | ${discoverySuccess.padEnd(10)} | ${crossSuccess.padEnd(6)} | ${gwPerNode.padEnd(7)} | ${health.padEnd(7)} | ${encrypt}`);
        });

        // Gateway performance analysis
        if (testResults.length > 1) {
            console.log('\n=== GATEWAY PERFORMANCE ANALYSIS ===');
            
            const firstResult = testResults[0];
            const lastResult = testResults[testResults.length - 1];
            
            // Store time scaling
            const storeDegradation = firstResult.avgGatewayStoreTime > 0 ? 
                ((lastResult.avgGatewayStoreTime - firstResult.avgGatewayStoreTime) / firstResult.avgGatewayStoreTime) * 100 : 0;
            console.log(`Gateway store time change from ${firstResult.nodeCount} to ${lastResult.nodeCount} nodes: ${storeDegradation.toFixed(1)}%`);
            
            // Discovery time scaling
            const discoveryDegradation = firstResult.avgGatewayDiscoveryTime > 0 ?
                ((lastResult.avgGatewayDiscoveryTime - firstResult.avgGatewayDiscoveryTime) / firstResult.avgGatewayDiscoveryTime) * 100 : 0;
            console.log(`Gateway discovery time change: ${discoveryDegradation.toFixed(1)}%`);
            
            // Success rate changes
            const storeSuccessChange = firstResult.gatewayStoreSuccessRate > 0 ?
                ((lastResult.gatewayStoreSuccessRate - firstResult.gatewayStoreSuccessRate) / firstResult.gatewayStoreSuccessRate) * 100 : 0;
            console.log(`Store success rate change: ${storeSuccessChange.toFixed(1)}%`);
            
            const discoverySuccessChange = firstResult.gatewayDiscoverySuccessRate > 0 ?
                ((lastResult.gatewayDiscoverySuccessRate - firstResult.gatewayDiscoverySuccessRate) / firstResult.gatewayDiscoverySuccessRate) * 100 : 0;
            console.log(`Discovery success rate change: ${discoverySuccessChange.toFixed(1)}%`);
            
            // Cross-node discovery efficiency
            const crossNodeChange = firstResult.crossNodeDiscoveryRate > 0 ?
                ((lastResult.crossNodeDiscoveryRate - firstResult.crossNodeDiscoveryRate) / firstResult.crossNodeDiscoveryRate) * 100 : 0;
            console.log(`Cross-node discovery efficiency change: ${crossNodeChange.toFixed(1)}%`);
            
            // Network health
            const healthChange = firstResult.networkHealth > 0 ?
                ((lastResult.networkHealth - firstResult.networkHealth) / firstResult.networkHealth) * 100 : 0;
            console.log(`Network health change: ${healthChange.toFixed(1)}%`);

            console.log('\n=== SCALABILITY INSIGHTS ===');
            
            // Gateway density
            const avgGatewayDensity = testResults.reduce((sum, r) => sum + r.avgGatewaysPerNode, 0) / testResults.length;
            console.log(`Average gateway density: ${avgGatewayDensity.toFixed(2)} gateways per node`);
            
            // Network efficiency
            const efficiencyScore = testResults.map(r => 
                (r.gatewayStoreSuccessRate + r.gatewayDiscoverySuccessRate + r.crossNodeDiscoveryRate) / 3
            );
            const avgEfficiency = efficiencyScore.reduce((sum, e) => sum + e, 0) / efficiencyScore.length;
            console.log(`Average network efficiency: ${(avgEfficiency * 100).toFixed(1)}%`);
            
            // Encryption effectiveness
            const avgEncryption = testResults.reduce((sum, r) => sum + r.encryptionCoverage, 0) / testResults.length;
            console.log(`Average encryption coverage: ${(avgEncryption * 100).toFixed(1)}%`);
        }

        console.log('\n=== RECOMMENDATIONS ===');
        
        if (testResults.length > 0) {
            const lastResult = testResults[testResults.length - 1];
            
            if (lastResult.crossNodeDiscoveryRate < 0.6) {
                console.log('- Consider optimizing DHT routing for better cross-node gateway discovery');
            }
            
            if (lastResult.avgGatewayStoreTime > 5000) {
                console.log('- Gateway storage times are high; consider parallel storage strategies');
            }
            
            if (lastResult.encryptionCoverage < 0.85) {
                console.log('- Improve key exchange mechanisms for better encryption coverage');
            }
            
            if (lastResult.networkHealth < 0.8) {
                console.log('- Network connectivity issues detected; review peer discovery algorithms');
            }
        }

        console.log(`\n=== FILES SAVED ===`);
        console.log(`Results have been saved to: ${process.cwd()}/test-results/gateway-scalability/`);
        console.log(`- CSV data: gateway-scalability-*.csv`);
        console.log(`- JSON summary: gateway-test-summary-*.json`);
        console.log(`- Markdown report: gateway-scalability-report-*.md`);
        console.log(`- Individual results: gateway-test-*nodes-*.json`);
    });
});