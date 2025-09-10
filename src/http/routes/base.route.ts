import { Router } from "express";
import KademliaNode from "../../node/node";
import BaseController from "../controller/base.controller";
import type { Routes } from "../interfaces/routes.interface";

class BaseRoute implements Routes {
	public router: Router = Router();
	public baseController: BaseController;
	public readonly path = "/";

	constructor(node: KademliaNode) {
		this.baseController = new BaseController(node);
		this.initializeRoutes();
	}

	private initializeRoutes(): void {
		// = BASIC NODE OPERATIONS =
		this.router.get(`${this.path}ping`, this.baseController.ping);
		this.router.get(`${this.path}getBucketNodes`, this.baseController.getNodeBuckets);
		this.router.get(`${this.path}getPeers`, this.baseController.getNodePeers);

		// = DHT OPERATIONS =
		this.router.get(`${this.path}findClosestNode/:id`, this.baseController.findClosestNode);
		this.router.get(`${this.path}store/:value`, this.baseController.storeValue);
		this.router.get(`${this.path}findValue/:key`, this.baseController.findValue);
		this.router.get(`${this.path}debugClosestNodes/:value`, this.baseController.debugClosestNodes);
		this.router.get(`${this.path}debugStorage/:key`, this.baseController.debugStorage);

		// = ENHANCED GATEWAY OPERATIONS =
		
		// Gateway Discovery
		this.router.get(`${this.path}findGateway/:blockchainId`, this.baseController.findGateways);
		
		// Gateway Registration
		this.router.post(`${this.path}storeGateway`, this.baseController.storeGateway);
		this.router.get(`${this.path}storeGateway/:blockchainId/:endpoint`, this.baseController.storeGatewaySimple);
		
		// Gateway Management
		this.router.get(`${this.path}gateways`, this.baseController.listGateways);
		this.router.get(`${this.path}gateway/:blockchainId/health`, this.baseController.checkGatewayHealth);

		 // = CRYPTO MANAGEMENT =
		this.router.get(`${this.path}crypto/publickey`, this.baseController.getPublicKey);
		this.router.get(`${this.path}crypto/keys`, this.baseController.getKnownKeys);
		this.router.get(`${this.path}crypto/stats`, this.baseController.getCryptoStats);
		
		// 2. GET-based encryption toggle (switch-style)
		this.router.get(`${this.path}crypto/encryption/:enabled`, this.baseController.setEncryption);
		
		// Key discovery
		this.router.post(`${this.path}crypto/discover`, this.baseController.discoverKeys);
		this.router.get(`${this.path}crypto/exchange-keys`, this.baseController.triggerKeyExchange);
		
		// = SECURE OPERATIONS =
		
		// 4. Secure operations
		this.router.get(`${this.path}secure/store/:value`, this.baseController.secureStore);
		this.router.get(`${this.path}secure/ping/:nodeId/:port`, this.baseController.securePing);
		this.router.post(`${this.path}secure/store`, this.baseController.secureStore);
		this.router.post(`${this.path}secure/ping`, this.baseController.securePing);

		// = TESTING & MONITORING =
		this.router.get(`${this.path}crypto/network-status`, this.baseController.networkCryptoStatus);

		// = SECURE GATEWAY OPERATIONS =
		// Secure gateway discovery
		this.router.get(`${this.path}secure/findGateway/:blockchainId`, this.baseController.findGatewaysSecure);
		
		// Secure gateway registration
		this.router.post(`${this.path}secure/storeGateway`, this.baseController.storeGatewaySecure);
		this.router.get(`${this.path}secure/storeGateway/:blockchainId/:endpoint`, this.baseController.storeGatewaySimpleSecure);
		
		// Secure gateway management
		this.router.get(`${this.path}secure/gateways`, this.baseController.listGatewaysSecure);
		this.router.get(`${this.path}secure/gateway/:blockchainId/health`, this.baseController.checkGatewayHealthSecure);

	}
}

export default BaseRoute;
