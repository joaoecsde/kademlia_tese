# Kademlia DHT Gateway System

A distributed hash table implementation using the Kademlia protocol with enhanced gateway functionality for blockchain interoperability.

## Usage
to use this and run the keygen process yourself. first clone the repo run 
```bash
pnpm install
```
then in order to start the serice export a default env for the boostrap node 3000 (fake bootstrap) or and easier way is to open up a bash terminal and run the following commands to set up env vars (its recommended to run d=the dev script when testing or just trying out the service ```
```
export NODE_ENV=development PORT=3000
nvm use 18.20.0
pnpm start // for single node (prod script)

// or

pnpm run start:dev // to run 16 nodes concurrently (dev script)
```
You can then observe the peer doscvery process and begin to interact with each nodes HTTP API for getting node information and sending messages

## Port Configuration

**Important**: The HTTP server is always deployed at `port 2000 + nodeId`

| Node ID | UDP Port | HTTP Port |
|---------|----------|-----------|
| 1       | 3001     | 2001      |
| 2       | 3002     | 2002      |
| 3       | 3003     | 2003      |
| 4       | 3004     | 2004      |
| 5       | 3005     | 2005      |

For all available HTTP methods, see `src/http/controller/basecontroller.ts`

## API Endpoints

### Basic Node Operations

**Health Check**
```bash
GET http://localhost:2001/ping
```

**Node Status** 
```bash
GET http://localhost:2001/status
```

**Get Node Buckets**
Returns a node's buckets and all peers stored in each
```bash
GET http://localhost:2001/getBucketNodes
```

**Get All Peers**
Returns all known peers
```bash
GET http://localhost:2001/getPeers
```

### DHT Operations

**Store Value**
Stores a value on a given node
```bash
GET http://localhost:2001/store/value
```

**Find Value**
Returns a previously stored value in the DHT
```bash
GET http://localhost:2001/findValue/value
```

**Find Closest Node**
Finds the closest node to a given ID
```bash
GET http://localhost:2001/findClosestNode/id
```

**Debug Closest Nodes**
To know where your value will be stored
```bash
GET http://localhost:2001/debugClosestNodes/value
```

**Debug Storage**
Debug storage for specific key
```bash
GET http://localhost:2001/debugStorage/key
```

### Gateway Operations

#### Gateway Registration

**Store Gateway (POST Method - Recommended)**
```bash
curl -X POST http://localhost:2001/storeGateway \
  -H "Content-Type: application/json" \
  -d '{
    "blockchainId": "hardhat1",
    "endpoint": "http://localhost:8545",
    "supportedProtocols": ["SATP", "ILP"]
  }'
```

**Store Gateway (GET Method - Simple)**
```bash
GET http://localhost:2001/storeGateway/hardhat1/http%3A%2F%2Flocalhost%3A8545

# With custom protocols
GET http://localhost:2001/storeGateway/hardhat1/http%3A%2F%2Flocalhost%3A8545?protocols=SATP,ILP
```

#### Gateway Discovery

**Find Gateways**
```bash
GET http://localhost:2002/findGateway/hardhat1

# Include unhealthy gateways
GET http://localhost:2002/findGateway/hardhat1?includeUnhealthy=true

# Filter by age (only gateways less than 30 minutes old)
GET http://localhost:2002/findGateway/hardhat1?maxAge=30

# Combine filters
GET http://localhost:2002/findGateway/hardhat1?includeUnhealthy=false&maxAge=60
```

#### Gateway Management

**List All Gateways**
List all gateways registered on this specific node
```bash
GET http://localhost:2001/gateways
```

**Gateway Health Check**
Check health of all gateways for a specific blockchain
```bash
GET http://localhost:2001/gateway/hardhat1/health
```

## Common Usage Examples

### Quick Gateway Test

```bash
# 1. Store a gateway on node 1
curl -X POST http://localhost:2001/storeGateway \
  -H "Content-Type: application/json" \
  -d '{"blockchainId": "hardhat1", "endpoint": "http://localhost:8545"}'

# 2. Find gateway from node 2 (tests DHT distribution)
curl "http://localhost:2002/findGateway/hardhat1?includeUnhealthy=true"

# 3. Check gateway health
curl "http://localhost:2001/gateway/hardhat1/health"

# 4. List all gateways on node 1
curl "http://localhost:2001/gateways"
```

### Multiple Blockchain Gateways

```bash
# Store different blockchain gateways
curl -X POST http://localhost:2001/storeGateway -H "Content-Type: application/json" \
  -d '{"blockchainId": "ethereum", "endpoint": "https://mainnet.infura.io/v3/your-key"}'

curl -X POST http://localhost:2002/storeGateway -H "Content-Type: application/json" \
  -d '{"blockchainId": "polygon", "endpoint": "https://polygon-rpc.com"}'

curl -X POST http://localhost:2003/storeGateway -H "Content-Type: application/json" \
  -d '{"blockchainId": "avalanche", "endpoint": "https://api.avax.network/ext/bc/C/rpc"}'

# Find any gateway from any node
curl "http://localhost:2001/findGateway/ethereum"
curl "http://localhost:2004/findGateway/polygon"
curl "http://localhost:2005/findGateway/avalanche"
```

## To run tests you do
```bash
npx jest --config jest.config.js src/test/NameOfTheTest
```

For the gateway tests you will need to start a hardhat gateway, to do this do:
```bash
cd EVM && npx hardhat node --hostname 0.0.0.0 --port 8545
```