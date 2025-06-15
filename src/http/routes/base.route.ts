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
		// === BASIC NODE OPERATIONS ===
		this.router.get(`${this.path}ping`, this.baseController.ping);
		this.router.get(`${this.path}getBucketNodes`, this.baseController.getNodeBuckets);
		this.router.get(`${this.path}getPeers`, this.baseController.getNodePeers);

		// === DHT OPERATIONS ===
		this.router.get(`${this.path}findClosestNode/:id`, this.baseController.findClosestNode);
		this.router.get(`${this.path}store/:value`, this.baseController.storeValue);
		this.router.get(`${this.path}findValue/:key`, this.baseController.findValue);
		this.router.get(`${this.path}debugClosestNodes/:value`, this.baseController.debugClosestNodes);
		this.router.get(`${this.path}debugStorage/:key`, this.baseController.debugStorage);

		// === MESSAGE OPERATIONS ===
		// DELETE AFTERWARDS
		this.router.get(`${this.path}getNodeMessages`, this.baseController.getNodeMessages);
		this.router.get(`${this.path}getNodeUdpMessages`, this.baseController.getNodeUDPMessages);
		this.router.post(`${this.path}postDirectMessage`, this.baseController.postDirectMessage);
		this.router.post(`${this.path}postBroadcast`, this.baseController.postBroadcast);

		// === ENHANCED GATEWAY OPERATIONS ===
		
		// Gateway Discovery
		this.router.get(`${this.path}findGateway/:blockchainId`, this.baseController.findGateways);
		
		// Gateway Registration
		this.router.post(`${this.path}storeGateway`, this.baseController.storeGateway);
		this.router.get(`${this.path}storeGateway/:blockchainId/:endpoint`, this.baseController.storeGatewaySimple);
		
		// Gateway Management
		this.router.get(`${this.path}gateways`, this.baseController.listGateways);
		this.router.get(`${this.path}gateway/:blockchainId/health`, this.baseController.checkGatewayHealth);
	}
}

export default BaseRoute;
