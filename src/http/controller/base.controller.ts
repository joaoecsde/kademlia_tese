import { NextFunction, Request, Response } from "express";
import { GatewayInfo } from "../../gateway/gateway";
import KademliaNode from "../../node/node";
import { hashKeyAndmapToKeyspace } from "../../utils/nodeUtils";

class BaseController {
	public node: KademliaNode;

	constructor(node: KademliaNode) {
		this.node = node;
	}

	public ping = async (req: Request, res: Response, next: NextFunction) => {
		return res.json({ message: "success" });
	};

	public getNodePeers = async (req: Request, res: Response, next: NextFunction) => {
		return res.json({ peers: this.node.table.getAllPeers() });
	};

	public getNodeBuckets = async (req: Request, res: Response, next: NextFunction) => {
		return res.json({ message: this.node.table.getAllBuckets() });
	};

	public findClosestNode = (req: Request, res: Response, next: NextFunction) => {
		try {
			const closest = this.node.table.findClosestNode(Number(req.params.id));
			return res.json({ result: closest });
		} catch (error) {
			next(error);
		}
	};

	public storeValue = async (req: Request, res: Response, next: NextFunction) => {
		try {
			const key = hashKeyAndmapToKeyspace(req.params.value);
			const closest = await this.node.store(key, req.params.value);
			return res.json({ result: closest, key });
		} catch (error) {
			next(error);
		}
	};

	public findValue = async (req: Request, res: Response, next: NextFunction) => {
		try {
			const result = await this.node.findValue(req.params.key);
			
			if (result && result.value) {
				return res.json({
					found: true,
					value: result.value,
					nodeInfo: result.nodeInfo,
					message: `Value found on node ${result.nodeInfo.nodeId} at ${result.nodeInfo.address}:${result.nodeInfo.port}`
				});
			} else {
				return res.json({
					found: false,
					value: null,
					message: "Value not found in the network"
				});
			}
		} catch (error) {
			next(error);
		}
	};

	public debugClosestNodes = async (req: Request, res: Response, next: NextFunction) => {
		try {
			const value = req.params.value;
			const closestNodes = this.node.debugClosestNodes(value);
			const key = hashKeyAndmapToKeyspace(value);
			
			return res.json({ 
				value,
				key,
				closestNodes,
				message: `Top nodes that should store "${value}" (key: ${key})`
			});
		} catch (error) {
			next(error);
		}
	};

	public findGateways = async (req: Request, res: Response, next: NextFunction) => {
		try {
			const { blockchainId } = req.params;
			const { includeUnhealthy = 'false', maxAge } = req.query;
			
			if (!blockchainId) {
				return res.status(400).json({ 
					error: 'blockchainId is required' 
				});
			}
			
			console.log(`API: Finding gateways for ${blockchainId}`);
			const allGateways = await this.node.findGateways(blockchainId);
			
			// Filter gateways based on query parameters
			let filteredGateways = allGateways;
			
			// Filter by age if specified
			if (maxAge) {
				const maxAgeMs = parseInt(maxAge as string) * 60 * 1000; // Convert minutes to ms
				filteredGateways = filteredGateways.filter(gw => 
					Date.now() - gw.timestamp <= maxAgeMs
				);
			}
			
			// Filter by health status
			if (includeUnhealthy === 'false') {
				filteredGateways = filteredGateways.filter(gw => {
					// Include gateways that are healthy OR have unknown health status
					// Only exclude if explicitly marked as unhealthy
					return gw.isHealthy !== false;
				});
			}
			
			// Enhance gateway info with computed fields
			const enhancedGateways = filteredGateways.map(gw => {
				const gateway = gw instanceof GatewayInfo ? gw : GatewayInfo.deserialize(JSON.stringify(gw));
				return gateway.toSummary();
			});
			
			return res.json({
				blockchainId,
				gateways: enhancedGateways,
				count: enhancedGateways.length,
				totalFound: allGateways.length,
				filtered: allGateways.length - enhancedGateways.length,
				searchedFrom: {
					nodeId: this.node.nodeId,
					httpPort: 2000 + this.node.nodeId, // Fixed: HTTP port is 2000 + nodeId
					udpPort: this.node.port
				},
				filters: {
					includeUnhealthy: includeUnhealthy === 'true',
					maxAge: maxAge ? `${maxAge} minutes` : 'none'
				},
				message: enhancedGateways.length > 0 
					? `Found ${enhancedGateways.length} gateway(s) for ${blockchainId}`
					: `No gateways found for ${blockchainId}`,
				timestamp: Date.now()
			});
		} catch (error) {
			console.error('Error finding gateways:', error);
			next(error);
		}
	};

	
	public storeGateway = async (req: Request, res: Response, next: NextFunction) => {
		try {
			const { blockchainId, endpoint, pubKey, performHealthCheck = true } = req.body;
			
			// Enhanced validation
			if (!blockchainId || !endpoint) {
				return res.status(400).json({
					success: false,
					error: 'Missing required fields: blockchainId and endpoint are required',
					received: { blockchainId, endpoint, pubKey }
				});
			}

			console.log(`API: Storing gateway ${blockchainId} -> ${endpoint}${pubKey ? ` with pubKey: ${pubKey.substring(0, 20)}...` : ''}`);

			// Create and validate gateway info
			let gatewayInfo: GatewayInfo;
			try {
				gatewayInfo = new GatewayInfo(
					blockchainId,
					this.node.nodeId,
					endpoint,
					pubKey
				);
			} catch (validationError) {
				return res.status(400).json({
					success: false,
					error: `Gateway validation failed: ${validationError.message}`,
					details: { blockchainId, endpoint, pubKey }
				});
			}

			// Optional health check
			if (performHealthCheck) {
				try {
					console.log(`Performing health check for ${endpoint}`);
					const healthResult = await this.performGatewayHealthCheck(endpoint);
					gatewayInfo.updateHealth(healthResult.healthy, healthResult.chainId);
					
					if (!healthResult.healthy) {
						console.warn(`Health check failed for ${endpoint}: ${healthResult.error}`);
					}
				} catch (healthError) {
					console.warn(`Health check error for ${endpoint}:`, healthError.message);
					gatewayInfo.updateHealth(false);
				}
			}
			
			// Generate storage keys
			const gatewayKey = hashKeyAndmapToKeyspace(`gw-${blockchainId}`);
			const specificKey = hashKeyAndmapToKeyspace(`gw-${blockchainId}-${this.node.nodeId}`);
			
			console.log(`Storing with keys: Primary=${gatewayKey}, Specific=${specificKey}`);
			
			// Store using both keys
			const results = await Promise.allSettled([
				this.node.store(gatewayKey, gatewayInfo.serialize()),
				this.node.store(specificKey, gatewayInfo.serialize())
			]);
			
			const successful = results.filter(r => r.status === 'fulfilled').length;
			const failed = results.filter(r => r.status === 'rejected').length;
			
			// Enhanced response
			return res.json({
				success: true,
				message: `Gateway for ${blockchainId} stored successfully on ${successful} key(s)`,
				gateway: gatewayInfo.toSummary(),
				storage: {
					successful,
					failed,
					keys: {
						primary: gatewayKey,
						specific: specificKey
					}
				},
				nodeInfo: {
					kademliaNodeId: this.node.nodeId,
					httpPort: 2000 + this.node.nodeId,
					udpPort: this.node.port
				},
				nextSteps: {
					findEndpoint: `/findGateway/${blockchainId}`,
					curlExample: `curl http://localhost:${2000 + this.node.nodeId}/findGateway/${blockchainId}`
				}
			});
			
		} catch (error) {
			console.error('Error storing gateway:', error);
			return res.status(500).json({
				success: false,
				error: 'Internal server error during gateway storage',
				details: error.message
			});
		}
	};

	
	public storeGatewaySimple = async (req: Request, res: Response, next: NextFunction) => {
		try {
			const { blockchainId, endpoint } = req.params;
			const { pubKey, healthCheck = 'true' } = req.query;
			
			const decodedEndpoint = decodeURIComponent(endpoint);
			console.log(`API: Storing gateway via GET ${blockchainId} -> ${decodedEndpoint}${pubKey ? ` with pubKey: ${String(pubKey).substring(0, 20)}` : ''}`);
			
			// Create and validate gateway info
			let gatewayInfo: GatewayInfo;
			try {
				gatewayInfo = new GatewayInfo(
					blockchainId,
					this.node.nodeId, 
					decodedEndpoint,
					pubKey as string
				);
			} catch (validationError) {
				return res.status(400).json({
					success: false,
					error: `Gateway validation failed: ${validationError.message}`,
					originalEndpoint: endpoint,
					decodedEndpoint,
					pubKey,
					example: 'Use: /storeGateway/hardhat1/http%3A%2F%2Flocalhost%3A8545?pubKey=yourPubKey'
				});
			}

			// Optional health check
			if (healthCheck === 'true') {
				try {
					const healthResult = await this.performGatewayHealthCheck(decodedEndpoint);
					gatewayInfo.updateHealth(healthResult.healthy, healthResult.chainId);
				} catch (healthError) {
					console.warn(`Health check error for ${decodedEndpoint}:`, healthError.message);
					gatewayInfo.updateHealth(false);
				}
			}
			
			const gatewayKey = hashKeyAndmapToKeyspace(`gw-${blockchainId}`);
			const specificKey = hashKeyAndmapToKeyspace(`gw-${blockchainId}-${this.node.nodeId}`);
			
			const results = await Promise.allSettled([
				this.node.store(gatewayKey, gatewayInfo.serialize()),
				this.node.store(specificKey, gatewayInfo.serialize())
			]);
			
			const successful = results.filter(r => r.status === 'fulfilled').length;
			const failed = results.filter(r => r.status === 'rejected').length;
			
			return res.json({
				success: true,
				message: `Gateway for ${blockchainId} stored successfully`,
				gateway: gatewayInfo.toSummary(),
				storage: {
					successful,
					failed,
					keys: {
						primary: gatewayKey,
						specific: specificKey
					}
				},
				nodeInfo: {
					kademliaNodeId: this.node.nodeId,
					httpPort: 2000 + this.node.nodeId,
					udpPort: this.node.port,
				},
				nextSteps: {
					findEndpoint: `/findGateway/${blockchainId}`,
					curlExample: `curl http://localhost:${2000 + this.node.nodeId}/findGateway/${blockchainId}`
				}
			});
			
		} catch (error) {
			console.error('Error storing gateway via URL params:', error);
			return res.status(500).json({
				success: false,
				error: 'Internal server error during gateway storage',
				details: error.message
			});
		}
	};

	public listGateways = async (req: Request, res: Response, next: NextFunction) => {
		try {
			const registeredGateways = this.node.getRegisteredGateways();
			const gatewayArray = Array.from(registeredGateways.entries()).map(([blockchainId, gateway]) => {
				const gw = gateway instanceof GatewayInfo ? gateway : GatewayInfo.deserialize(JSON.stringify(gateway));
				return gw.toSummary();
			});
			
			return res.json({
				nodeId: this.node.nodeId,
				totalGateways: gatewayArray.length,
				gateways: gatewayArray,
				message: `Node ${this.node.nodeId} has ${gatewayArray.length} registered gateway(s)`,
				timestamp: Date.now()
			});
		} catch (error) {
			next(error);
		}
	};

	public checkGatewayHealth = async (req: Request, res: Response, next: NextFunction) => {
		try {
			const { blockchainId } = req.params;
			const gateways = await this.node.findGateways(blockchainId);
			
			if (gateways.length === 0) {
				return res.json({
					blockchainId,
					status: 'not_found',
					totalGateways: 0,
					healthyGateways: 0,
					gateways: [],
					message: `No gateways found for ${blockchainId}`
				});
			}
			
			console.log(`Performing health checks for ${gateways.length} ${blockchainId} gateways`);
			
			// Check health of each gateway
			const healthChecks = await Promise.allSettled(
				gateways.map(async (gateway) => {
					const healthResult = await this.performGatewayHealthCheck(gateway.endpoint);
					return {
						...gateway,
						...healthResult,
						age: Date.now() - gateway.timestamp
					};
				})
			);
			
			const healthResults = healthChecks.map(result => 
				result.status === 'fulfilled' ? result.value : {
					healthy: false,
					error: 'Health check failed'
				}
			);
			
			const healthyCount = healthResults.filter(r => r.healthy).length;
			
			return res.json({
				blockchainId,
				totalGateways: gateways.length,
				healthyGateways: healthyCount,
				status: healthyCount > 0 ? 'healthy' : 'unhealthy',
				gateways: healthResults,
				message: `${healthyCount}/${gateways.length} gateways healthy for ${blockchainId}`,
				timestamp: Date.now()
			});
		} catch (error) {
			next(error);
		}
	};

	// Helper method to perform gateway health checks
	private async performGatewayHealthCheck(endpoint: string): Promise<{
		healthy: boolean;
		chainId?: number;
		responseTime?: number;
		error?: string;
	}> {
		const startTime = Date.now();
		
		try {
			
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout
			
			const response = await fetch(endpoint, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					jsonrpc: '2.0',
					method: 'eth_chainId',
					params: [],
					id: 1
				}),
				signal: controller.signal
			});
			
			clearTimeout(timeoutId);
			
			if (!response.ok) {
				return {
					healthy: false,
					responseTime: Date.now() - startTime,
					error: `HTTP ${response.status}: ${response.statusText}`
				};
			}
			
			const data = await response.json();
			const responseTime = Date.now() - startTime;
			
			if (data.result) {
				return {
					healthy: true,
					chainId: parseInt(data.result, 16),
					responseTime
				};
			} else {
				return {
					healthy: false,
					responseTime,
					error: data.error?.message || 'No result in response'
				};
			}
		} catch (error) {
			return {
				healthy: false,
				responseTime: Date.now() - startTime,
				error: error.message
			};
		}
	}

	public debugStorage = async (req: Request, res: Response, next: NextFunction) => {
		try {
			const { key } = req.params;
			
			if (!key) {
				return res.status(400).json({ error: 'Key parameter required' });
			}
			
			// Try multiple key formats
			const numericKey = Number(key);
			const directResult = await this.node.table.findValue(key);
			const hashedKey = hashKeyAndmapToKeyspace(key);
			const hashedResult = await this.node.table.findValue(hashedKey.toString());
			
			// Try gateway-specific formats
			const gatewayKey = hashKeyAndmapToKeyspace(`gw-${key}`);
			const gatewayResult = await this.node.table.findValue(gatewayKey.toString());
			
			const allPeers = this.node.table.getAllPeers();
			
			return res.json({
				query: {
					originalKey: key,
					numericKey,
					hashedKey,
					gatewayKey
				},
				results: {
					direct: {
						found: directResult !== undefined,
						type: typeof directResult,
						value: typeof directResult === 'string' ? directResult.substring(0, 200) : directResult
					},
					hashed: {
						found: hashedResult !== undefined,
						type: typeof hashedResult,
						value: typeof hashedResult === 'string' ? hashedResult.substring(0, 200) : hashedResult
					},
					gateway: {
						found: gatewayResult !== undefined,
						type: typeof gatewayResult,
						value: typeof gatewayResult === 'string' ? gatewayResult.substring(0, 200) : gatewayResult
					}
				},
				nodeInfo: {
					nodeId: this.node.nodeId,
					totalPeers: allPeers.length,
					buckets: this.node.table.getAllBucketsLen(),
					httpPort: 2000 + this.node.nodeId, 
					udpPort: this.node.port
				},
				localStorage: (this.node.table as any).store ? 
					Array.from((this.node.table as any).store.entries()).slice(0, 10).map(([k, v]) => ({
						key: k,
						valueType: typeof v,
						valuePreview: typeof v === 'string' ? v.substring(0, 100) : String(v)
					})) : 
					'Storage not accessible'
			});
			
		} catch (error) {
			console.error('Debug storage error:', error);
			next(error);
		}
	};

	public getPublicKey = async (req: Request, res: Response, next: NextFunction) => {
		try {
		return res.json({
			nodeId: this.node.nodeId,
			publicKey: this.node.getCryptoManager().getPublicKey(),
			fingerprint: this.node.getPublicKeyFingerprint(),
			timestamp: Date.now()
		});
		} catch (error) {
		next(error);
		}
  };

	public getKnownKeys = async (req: Request, res: Response, next: NextFunction) => {
		try {
		const knownKeys = this.node.getKnownPublicKeys();
		return res.json({
			nodeId: this.node.nodeId,
			totalKeys: knownKeys.length,
			keys: knownKeys,
			timestamp: Date.now()
		});
		} catch (error) {
		next(error);
		}
	};

	public getCryptoStats = async (req: Request, res: Response, next: NextFunction) => {
		try {
		const stats = this.node.getCryptoStats();
		return res.json({
			nodeId: this.node.nodeId,
			...stats,
			timestamp: Date.now()
		});
		} catch (error) {
		next(error);
		}
	};

	public setEncryption = async (req: Request, res: Response, next: NextFunction) => {
		try {
			const { enabled } = req.params; // true/false from URL
			
			if (enabled !== 'true' && enabled !== 'false') {
			return res.status(400).json({
				success: false,
				error: 'enabled must be "true" or "false"',
				example: 'Use: /crypto/encryption/true or /crypto/encryption/false'
			});
			}

			const enabledBool = enabled === 'true';
			this.node.setEncryptionEnabled(enabledBool);
			
			return res.json({
			success: true,
			message: `Encryption ${enabledBool ? 'enabled' : 'disabled'}`,
			encryptionEnabled: enabledBool,
			nodeId: this.node.nodeId,
			timestamp: Date.now()
			});
		} catch (error) {
			next(error);
		}
	};

	public discoverKeys = async (req: Request, res: Response, next: NextFunction) => {
		try {
		const allPeers = this.node.table.getAllPeers();
		const peerNodes = allPeers.map(peer => ({
			nodeId: peer.nodeId,
			address: peer.address,
			port: peer.port
		}));

		await this.node.getKeyDiscoveryManager().discoverKeys(peerNodes);
		
		const discoveredKeys = this.node.getKnownPublicKeys();
		
		return res.json({
			success: true,
			message: `Key discovery completed`,
			totalPeers: peerNodes.length,
			discoveredKeys: discoveredKeys.length,
			keys: discoveredKeys,
			timestamp: Date.now()
		});
		} catch (error) {
		next(error);
		}
	};

  	// === SECURE DHT OPERATIONS ===

	public secureStore = async (req: Request, res: Response, next: NextFunction) => {
		try {
			const { value } = req.params; // Only value, no key parameter
			
			if (!value) {
			return res.status(400).json({
				success: false,
				error: 'value is required',
				example: 'Use: /secure/store/mySecretData (not /secure/store/key/value)'
			});
			}

			const decodedValue = decodeURIComponent(value);
			
			// Generate key the same way as regular store (hash the value)
			const key = hashKeyAndmapToKeyspace(decodedValue);
			
			console.log(`Secure store: "${decodedValue}" -> key ${key}`);
			
			const results = await this.node.secureStore(key, decodedValue);
			const successful = results.filter(r => r.status === 'fulfilled').length;
			
			return res.json({
			success: true,
			message: `Secure store completed on ${successful} nodes`,
			value: decodedValue,
			generatedKey: key,
			encrypted: this.node.isEncryptionEnabled(),
			results: successful,
			nodeId: this.node.nodeId,
			howToFind: `Use: /findValue/${encodeURIComponent(decodedValue)}`,
			timestamp: Date.now()
			});
		} catch (error) {
			next(error);
		}
	};

  	public securePing = async (req: Request, res: Response, next: NextFunction) => {
		try {
			const { nodeId, port } = req.params;
			const address = req.query.address || '127.0.0.1'; // Default to localhost
			
			if (!nodeId || !port) {
			return res.status(400).json({
				success: false,
				error: 'nodeId and port are required',
				example: 'Use: /secure/ping/1/3001 or /secure/ping/1/3001?address=192.168.1.100'
			});
			}

			const result = await this.node.securePing(Number(nodeId), String(address), Number(port));
			
			return res.json({
			success: result,
			message: result ? 'Secure ping successful' : 'Secure ping failed',
			target: { 
				nodeId: Number(nodeId), 
				address: String(address), 
				port: Number(port) 
			},
			encryptionEnabled: this.node.isEncryptionEnabled(),
			timestamp: Date.now()
			});
		} catch (error) {
		next(error);
		}
  	};

	public networkCryptoStatus = async (req: Request, res: Response, next: NextFunction) => {
		try {
			const allPeers = this.node.table.getAllPeers();
			const knownKeys = this.node.getKnownPublicKeys();
			
			const peerCryptoStatus = allPeers.map(peer => {
			const hasKey = knownKeys.find(k => k.nodeId === peer.nodeId);
			return {
				nodeId: peer.nodeId,
				port: peer.port,
				hasPublicKey: !!hasKey,
				keyTimestamp: hasKey ? hasKey.timestamp : null,
				canEncrypt: !!hasKey,
				keyAge: hasKey ? Math.floor((Date.now() - hasKey.timestamp) / 1000 / 60) + ' minutes' : 'N/A'
			};
			});
			
			const encryptionReadyCount = peerCryptoStatus.filter(p => p.canEncrypt).length;
			const missingKeys = peerCryptoStatus.filter(p => !p.canEncrypt);
			
			return res.json({
			nodeId: this.node.nodeId,
			encryptionEnabled: this.node.isEncryptionEnabled(),
			totalPeers: allPeers.length,
			encryptionReady: encryptionReadyCount,
			encryptionCoverage: allPeers.length > 0 ? (encryptionReadyCount / allPeers.length * 100).toFixed(1) + '%' : '0%',
			peers: peerCryptoStatus,
			missingKeys: missingKeys.map(p => ({
				nodeId: p.nodeId,
				suggestion: `Try: curl -X GET http://localhost:${this.node.nodeId + 2000}/secure/ping/${p.nodeId}/${p.port}`
			})),
			ownPublicKeyFingerprint: this.node.getPublicKeyFingerprint(),
			suggestions: {
				triggerDiscovery: `curl -X POST http://localhost:${this.node.nodeId + 2000}/crypto/discover`,
				pingMissingNodes: missingKeys.length > 0 ? `Try pinging nodes: ${missingKeys.map(p => p.nodeId).join(', ')}` : 'All nodes have keys!'
			},
			timestamp: Date.now()
			});
		} catch (error) {
			next(error);
		}
	};

	public triggerKeyExchange = async (req: Request, res: Response, next: NextFunction) => {
		try {
			await this.node.triggerKeyExchangeWithAllPeers();
			
			const knownKeys = this.node.getKnownPublicKeys();
			const allPeers = this.node.table.getAllPeers();
			
			return res.json({
			success: true,
			message: 'Key exchange triggered with all peers',
			totalPeers: allPeers.length,
			keysObtained: knownKeys.length,
			coverage: allPeers.length > 0 ? (knownKeys.length / allPeers.length * 100).toFixed(1) + '%' : '0%',
			keys: knownKeys.map(k => ({
				nodeId: k.nodeId,
				fingerprint: require('crypto').createHash('sha256').update(k.publicKey).digest('hex').substring(0, 16),
				age: Math.floor((Date.now() - k.timestamp) / 1000) + 's'
			})),
			nextStep: 'Try findValue operations - they should now be encrypted!',
			timestamp: Date.now()
			});
		} catch (error) {
			next(error);
		}
	};

	public findGatewaysSecure = async (req: Request, res: Response, next: NextFunction) => {
		try {
			const { blockchainId } = req.params;
			const { includeUnhealthy = 'false', maxAge } = req.query;
			
			if (!blockchainId) {
				return res.status(400).json({ 
					error: 'blockchainId is required' 
				});
			}
			
			console.log(`API: Secure finding gateways for ${blockchainId}`);
			const allGateways = await this.node.findGatewaysSecure(blockchainId);
			
			// Filter gateways based on query parameters
			let filteredGateways = allGateways;
			
			// Filter by age if specified
			if (maxAge) {
				const maxAgeMs = parseInt(maxAge as string) * 60 * 1000;
				filteredGateways = filteredGateways.filter(gw => 
					Date.now() - gw.timestamp <= maxAgeMs
				);
			}
			
			// Filter by health status
			if (includeUnhealthy === 'false') {
				filteredGateways = filteredGateways.filter(gw => {
					return gw.isHealthy !== false;
				});
			}
			
			// Enhance gateway info with computed fields
			const enhancedGateways = filteredGateways.map(gw => {
				const gateway = gw instanceof GatewayInfo ? gw : GatewayInfo.deserialize(JSON.stringify(gw));
				return gateway.toSummary();
			});
			
			return res.json({
				blockchainId,
				gateways: enhancedGateways,
				count: enhancedGateways.length,
				totalFound: allGateways.length,
				filtered: allGateways.length - enhancedGateways.length,
				searchedFrom: {
					nodeId: this.node.nodeId,
					httpPort: 2000 + this.node.nodeId,
					udpPort: this.node.port
				},
				encrypted: this.node.isEncryptionEnabled(),
				encryptionCoverage: this.getEncryptionCoverage(),
				filters: {
					includeUnhealthy: includeUnhealthy === 'true',
					maxAge: maxAge ? `${maxAge} minutes` : 'none'
				},
				message: enhancedGateways.length > 0 
					? `Found ${enhancedGateways.length} gateway(s) for ${blockchainId} (secure)`
					: `No gateways found for ${blockchainId}`,
				timestamp: Date.now()
			});
		} catch (error) {
			console.error('Error finding gateways securely:', error);
			next(error);
		}
	};

	public storeGatewaySecure = async (req: Request, res: Response, next: NextFunction) => {
		try {
			const { blockchainId, endpoint, pubKey, performHealthCheck = true } = req.body;
			
			if (!blockchainId || !endpoint) {
				return res.status(400).json({
					success: false,
					error: 'Missing required fields: blockchainId and endpoint are required',
					received: { blockchainId, endpoint, pubKey }
				});
			}

			console.log(`API: Secure storing gateway ${blockchainId} -> ${endpoint}${pubKey ? ` with pubKey: ${pubKey.substring(0, 20)}...` : ''}`);

			// Create and validate gateway info
			let gatewayInfo: GatewayInfo;
			try {
				gatewayInfo = new GatewayInfo(
					blockchainId,
					this.node.nodeId,
					endpoint,
					pubKey
				);
			} catch (validationError) {
				return res.status(400).json({
					success: false,
					error: `Gateway validation failed: ${validationError.message}`,
					details: { blockchainId, endpoint, pubKey }
				});
			}

			// Optional health check
			if (performHealthCheck) {
				try {
					console.log(`Performing health check for ${endpoint}`);
					const healthResult = await this.performGatewayHealthCheck(endpoint);
					gatewayInfo.updateHealth(healthResult.healthy, healthResult.chainId);
					
					if (!healthResult.healthy) {
						console.warn(`Health check failed for ${endpoint}: ${healthResult.error}`);
					}
				} catch (healthError) {
					console.warn(`Health check error for ${endpoint}:`, healthError.message);
					gatewayInfo.updateHealth(false);
				}
			}
			
			// Store using secure method
			const results = await this.node.storeGatewaySecure(gatewayInfo);
			
			const successful = results.filter(r => r.status === 'fulfilled').length;
			const failed = results.filter(r => r.status === 'rejected').length;
			
			// Enhanced response
			return res.json({
				success: true,
				message: `Gateway for ${blockchainId} stored securely on ${successful} nodes`,
				gateway: gatewayInfo.toSummary(),
				storage: {
					successful,
					failed,
					encrypted: this.node.isEncryptionEnabled(),
					encryptionCoverage: this.getEncryptionCoverage()
				},
				nodeInfo: {
					kademliaNodeId: this.node.nodeId,
					httpPort: 2000 + this.node.nodeId,
					udpPort: this.node.port
				},
				nextSteps: {
					findEndpoint: `/secure/findGateway/${blockchainId}`,
					curlExample: `curl http://localhost:${2000 + this.node.nodeId}/secure/findGateway/${blockchainId}`
				}
			});
			
		} catch (error) {
			console.error('Error storing gateway securely:', error);
			return res.status(500).json({
				success: false,
				error: 'Internal server error during secure gateway storage',
				details: error.message
			});
		}
	};

	public storeGatewaySimpleSecure = async (req: Request, res: Response, next: NextFunction) => {
		try {
			const { blockchainId, endpoint } = req.params;
			const { pubKey, healthCheck = 'true' } = req.query;
			
			const decodedEndpoint = decodeURIComponent(endpoint);
			console.log(`API: Secure storing gateway via GET ${blockchainId} -> ${decodedEndpoint}${pubKey ? ` with pubKey: ${String(pubKey).substring(0, 20)}...` : ''}`);
			
			// Create and validate gateway info
			let gatewayInfo: GatewayInfo;
			try {
				gatewayInfo = new GatewayInfo(
					blockchainId,
					this.node.nodeId, 
					decodedEndpoint,
					pubKey as string
				);
			} catch (validationError) {
				return res.status(400).json({
					success: false,
					error: `Gateway validation failed: ${validationError.message}`,
					originalEndpoint: endpoint,
					decodedEndpoint,
					pubKey,
					example: 'Use: /secure/storeGateway/hardhat1/http%3A%2F%2Flocalhost%3A8545?pubKey=yourPubKey'
				});
			}

			// Optional health check
			if (healthCheck === 'true') {
				try {
					const healthResult = await this.performGatewayHealthCheck(decodedEndpoint);
					gatewayInfo.updateHealth(healthResult.healthy, healthResult.chainId);
				} catch (healthError) {
					console.warn(`Health check error for ${decodedEndpoint}:`, healthError.message);
					gatewayInfo.updateHealth(false);
				}
			}
			
			// Store using secure method
			const results = await this.node.storeGatewaySecure(gatewayInfo);
			
			const successful = results.filter(r => r.status === 'fulfilled').length;
			const failed = results.filter(r => r.status === 'rejected').length;
			
			return res.json({
				success: true,
				message: `Gateway for ${blockchainId} stored securely`,
				gateway: gatewayInfo.toSummary(),
				storage: {
					successful,
					failed,
					encrypted: this.node.isEncryptionEnabled(),
					encryptionCoverage: this.getEncryptionCoverage()
				},
				nodeInfo: {
					kademliaNodeId: this.node.nodeId,
					httpPort: 2000 + this.node.nodeId,
					udpPort: this.node.port,
				},
				nextSteps: {
					findEndpoint: `/secure/findGateway/${blockchainId}`,
					curlExample: `curl http://localhost:${2000 + this.node.nodeId}/secure/findGateway/${blockchainId}`
				}
			});
		
		} catch (error) {
			console.error('Error storing gateway securely via URL params:', error);
			return res.status(500).json({
				success: false,
				error: 'Internal server error during secure gateway storage',
				details: error.message
			});
		}
	};

	public listGatewaysSecure = async (req: Request, res: Response, next: NextFunction) => {
		try {
			const registeredGateways = this.node.getRegisteredGateways();
			const gatewayArray = Array.from(registeredGateways.entries()).map(([blockchainId, gateway]) => {
				const gw = gateway instanceof GatewayInfo ? gateway : GatewayInfo.deserialize(JSON.stringify(gateway));
				return gw.toSummary();
			});
			
			return res.json({
				nodeId: this.node.nodeId,
				totalGateways: gatewayArray.length,
				gateways: gatewayArray,
				encrypted: this.node.isEncryptionEnabled(),
				encryptionCoverage: this.getEncryptionCoverage(),
				message: `Node ${this.node.nodeId} has ${gatewayArray.length} registered gateway(s) (secure)`,
				security: {
					encryptionEnabled: this.node.isEncryptionEnabled(),
					knownKeys: this.node.getKnownPublicKeys().length,
					publicKeyFingerprint: this.node.getPublicKeyFingerprint()
				},
				timestamp: Date.now()
			});
		} catch (error) {
			next(error);
		}
	};

	public checkGatewayHealthSecure = async (req: Request, res: Response, next: NextFunction) => {
		try {
			const { blockchainId } = req.params;
			const gateways = await this.node.findGatewaysSecure(blockchainId);
			
			if (gateways.length === 0) {
				return res.json({
					blockchainId,
					status: 'not_found',
					totalGateways: 0,
					healthyGateways: 0,
					gateways: [],
					encrypted: this.node.isEncryptionEnabled(),
					message: `No gateways found for ${blockchainId} (secure search)`
				});
			}
			
			console.log(`Performing secure health checks for ${gateways.length} ${blockchainId} gateways`);
			
			// Check health of each gateway
			const healthChecks = await Promise.allSettled(
				gateways.map(async (gateway) => {
					const healthResult = await this.performGatewayHealthCheck(gateway.endpoint);
					return {
						...gateway,
						...healthResult,
						age: Date.now() - gateway.timestamp
					};
				})
			);
			
			const healthResults = healthChecks.map(result => 
				result.status === 'fulfilled' ? result.value : {
					healthy: false,
					error: 'Health check failed'
				}
			);
			
			const healthyCount = healthResults.filter(r => r.healthy).length;
			
			return res.json({
				blockchainId,
				totalGateways: gateways.length,
				healthyGateways: healthyCount,
				status: healthyCount > 0 ? 'healthy' : 'unhealthy',
				gateways: healthResults,
				encrypted: this.node.isEncryptionEnabled(),
				encryptionCoverage: this.getEncryptionCoverage(),
				message: `${healthyCount}/${gateways.length} gateways healthy for ${blockchainId} (secure)`,
				security: {
					encryptionEnabled: this.node.isEncryptionEnabled(),
					searchWasEncrypted: this.node.isEncryptionEnabled(),
					knownKeys: this.node.getKnownPublicKeys().length
				},
				timestamp: Date.now()
			});
		} catch (error) {
			next(error);
		}
		};

		// Helper method to get encryption coverage
		private getEncryptionCoverage(): string {
		const allPeers = this.node.table.getAllPeers();
		const knownKeys = this.node.getKnownPublicKeys();

		if (allPeers.length === 0) return '0%';

		const encryptionReady = knownKeys.length;
		return ((encryptionReady / allPeers.length) * 100).toFixed(1) + '%';
	}
}

export default BaseController;