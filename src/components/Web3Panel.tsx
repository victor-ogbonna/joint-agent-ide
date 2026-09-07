import React, { useState } from 'react';
import { Wallet, Send, Link } from 'lucide-react';
import { connectWallet, sendSensorDataToContract } from '../web3_utils';

interface Web3PanelProps {
  walletState: any;
  setWalletState: any;
}

export default function Web3Panel({ walletState, setWalletState }: Web3PanelProps) {
  const [contractAddress, setContractAddress] = useState("");
  const [sensorData, setSensorData] = useState("");
  const [status, setStatus] = useState("");

  const handleConnect = async () => {
    try {
      setWalletState({ ...walletState, authenticating: true });
      const data = await connectWallet();
      setWalletState({
        connected: true,
        address: data.address,
        chainId: data.chainId,
        balance: data.balance,
        authenticating: false,
        authenticated: true
      });
      setStatus("Wallet connected!");
    } catch (err: any) {
      setWalletState({ ...walletState, authenticating: false });
      setStatus("Error: " + err.message);
    }
  };

  const handleSend = async () => {
    if (!contractAddress || !sensorData) {
      setStatus("Please provide contract address and data.");
      return;
    }
    setStatus("Sending transaction...");
    try {
      const hash = await sendSensorDataToContract(contractAddress, sensorData);
      setStatus(`Success! Tx Hash: ${hash}`);
    } catch (err: any) {
      setStatus(`Tx Error: ${err.message}`);
    }
  };

  return (
    <div className="flex flex-col h-full bg-[var(--bg-panel)] text-[var(--text-main)] text-sm border-l border-[var(--border-main)]">
      <div className="p-3 border-b border-[var(--border-main)] flex items-center gap-2 bg-[var(--bg-surface)] font-medium">
        <Wallet size={16} className="text-blue-500" />
        Web3 Oracle
      </div>

      <div className="p-3 space-y-4 overflow-y-auto flex-1">
        {!walletState.connected ? (
          <div className="text-center space-y-3 mt-4">
            <p className="text-xs text-[var(--text-muted)]">Connect MetaMask to send microcontroller sensor data to any Ethereum-compatible network.</p>
            <button 
              onClick={handleConnect}
              disabled={walletState.authenticating}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium text-xs transition disabled:opacity-50"
            >
              {walletState.authenticating ? "Connecting..." : "Connect MetaMask"}
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="p-2 bg-[var(--bg-root)] border border-[var(--border-main)] rounded text-xs space-y-1 break-all">
              <p><span className="text-[var(--text-muted)]">Address:</span> {walletState.address}</p>
              <p><span className="text-[var(--text-muted)]">Balance:</span> {walletState.balance} ETH</p>
            </div>

            <div className="space-y-2">
              <label className="text-xs text-[var(--text-muted)] font-medium">Smart Contract Address</label>
              <input 
                type="text" 
                value={contractAddress}
                onChange={(e) => setContractAddress(e.target.value)}
                className="w-full bg-[var(--bg-root)] border border-[var(--border-main)] rounded px-2 py-1.5 text-xs focus:outline-none focus:border-blue-500"
                placeholder="0x..."
              />
            </div>

            <div className="space-y-2">
              <label className="text-xs text-[var(--text-muted)] font-medium">Sensor Data Payload</label>
              <input 
                type="text" 
                value={sensorData}
                onChange={(e) => setSensorData(e.target.value)}
                className="w-full bg-[var(--bg-root)] border border-[var(--border-main)] rounded px-2 py-1.5 text-xs focus:outline-none focus:border-blue-500"
                placeholder="e.g. Temp: 24C, Hum: 50%"
              />
            </div>

            <button 
              onClick={handleSend}
              className="w-full py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded text-xs font-medium transition flex justify-center items-center gap-2"
            >
              <Send size={14} /> Publish to Blockchain
            </button>
          </div>
        )}

        {status && (
          <div className="mt-4 p-2 rounded text-xs border border-[var(--border-main)] bg-[var(--bg-root)] break-all">
            {status}
          </div>
        )}
      </div>
    </div>
  );
}
