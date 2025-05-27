# Kademlia 

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

### Other methods
note when using something like post man to call these GET endpoints. the http server is always deployed at port 2000 + nodeiD. To see all available HTTPS methods see `src/http/router/routes.ts`

Returns a nodes buckets and all of the peers stored in each
```bash
GET- http://localhost:2001/getBucketNodes
```

Stores a value on a given node
```bash
GET- http://localhost:3001/store/value
```

Returns a previously stored value in he DHT
```bash
GET- http://localhost:2001/findValue/value
```

Finds the closest node to a given id
```bash
GET- http://localhost:2001/findClosestNode/id
```

All known peers
```bash
GET- http://localhost:2001/getPeers
```

To know where your value will be stored
```bash
GET- http://localhost:2001/debugClosestNodes/value
```

### To run tests you do

```bash
npx jest --config jest.config.js src/test/NameOfTheTest
```