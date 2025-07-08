// SPDX-License-Identifier: GPL-3.0

pragma solidity ^0.8.20;

/*
 *  Smart Contract Interface to define the methods needed by SATP Wrapper Contract.
 */

interface SATPTokenContractInterface {
  // mint creates new tokens with the given amount and assigns them to the owner.
  function mint(address account, uint256 amount) external returns (bool); 
  // burn destroys the given amount of tokens from the owner.
  function burn(address account, uint256 amount) external returns (bool);
  // assign assigns the given amount of tokens from the owner to the target, without approval.
  function assign(address from, address recipient, uint256 amount) external returns (bool);
  // checks if the given account has the given role.
  function hasBridgeRole(address account) external view returns (bool);
}
