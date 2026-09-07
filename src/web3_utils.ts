import { ethers } from 'ethers';

export const connectWallet = async () => {
  if (!(window as any).ethereum) {
    throw new Error("MetaMask is not installed. Please install it to use this feature.");
  }
  const provider = new ethers.BrowserProvider((window as any).ethereum);
  const accounts = await provider.send("eth_requestAccounts", []);
  if (!accounts || accounts.length === 0) {
    throw new Error("No accounts found.");
  }
  const network = await provider.getNetwork();
  const balanceRaw = await provider.getBalance(accounts[0]);
  const balance = ethers.formatEther(balanceRaw);
  return {
    address: accounts[0],
    chainId: network.chainId.toString(),
    balance,
    provider
  };
};

export const sendSensorDataToContract = async (contractAddress: string, data: string) => {
  if (!(window as any).ethereum) {
    throw new Error("MetaMask is not installed.");
  }
  const provider = new ethers.BrowserProvider((window as any).ethereum);
  const signer = await provider.getSigner();
  
  // Minimal ABI for a storeData function
  const abi = [
    "function storeData(string memory data) public",
    "function sensorData() public view returns (string memory)"
  ];
  
  const contract = new ethers.Contract(contractAddress, abi, signer);
  const tx = await contract.storeData(data);
  const receipt = await tx.wait();
  return receipt.hash;
};
