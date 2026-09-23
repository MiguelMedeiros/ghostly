// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
// Worthless local-only fixture. This is NOT a Tether-issued token.
contract TestUSDT {
    string public constant name = "Ghostly Test Token";
    string public constant symbol = "TEST-USDT";
    uint8 public immutable decimals;
    mapping(address => uint256) public balanceOf;
    mapping(address => bool) public blocked;
    event Transfer(address indexed from, address indexed to, uint256 value);
    constructor(uint8 precision) { decimals = precision; }
    function mint(address to, uint256 amount) external {
        require(block.chainid == 31337, "local only");
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }
    function setBlocked(address account, bool value) external {
        require(block.chainid == 31337, "local only");
        blocked[account] = value;
    }
    function transfer(address to, uint256 amount) external returns (bool) {
        require(to != address(0) && !blocked[msg.sender] && !blocked[to], "blocked");
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }
}
