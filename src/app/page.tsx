"use client";
import { useState, useMemo } from "react";
import { Keypair, PublicKey, Connection, LAMPORTS_PER_SOL, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";

// Constants for fee calculations
const FEE_PER_TRANSACTION = 5000; // Base fee per transaction
const RENT_EXEMPT = 890880; // Minimum SOL for rent exemption
const SAFETY_BUFFER = 100000; // Increased safety buffer to 0.0001 SOL
const FEE_PER_TRANSFER = FEE_PER_TRANSACTION + SAFETY_BUFFER; // Total fee per transfer

// RPC endpoint
const RPC_ENDPOINT = "https://solana-mainnet.rpc.extrnode.com/0f16d600-618e-4c5d-9e8f-49743c01af7f";

// Function to get connection
const getConnection = () => {
  return new Connection(RPC_ENDPOINT, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 60000,
    wsEndpoint: RPC_ENDPOINT.replace('https', 'wss')
  });
};

export default function Home() {
  const [numLandingWallets, setNumLandingWallets] = useState(1);
  const [wallets, setWallets] = useState<any>(null);
  const [showWallets, setShowWallets] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [dispersing, setDispersing] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [withdrawAddress, setWithdrawAddress] = useState<string>("");
  const [withdrawing, setWithdrawing] = useState(false);
  const [minAmount, setMinAmount] = useState<number>(0.1);
  const [maxAmount, setMaxAmount] = useState<number>(0.5);
  const [balances, setBalances] = useState<{ [key: string]: number }>({});
  const [walletStatuses, setWalletStatuses] = useState<{ [key: string]: string }>({});

  // Calculate estimated total SOL needed
  const estimatedTotal = useMemo(() => {
    const TOTAL_TRANSACTIONS = 1 + (numLandingWallets * 3); // Initial transfer + 3 transfers per landing wallet
    const totalFees = TOTAL_TRANSACTIONS * FEE_PER_TRANSFER;
    const totalRentExempt = RENT_EXEMPT * (numLandingWallets + 1); // Rent exempt for funding wallet and all landing wallets
    const totalRandomAmount = numLandingWallets * maxAmount * LAMPORTS_PER_SOL; // Maximum possible random amounts
    
    const totalInLamports = totalFees + totalRentExempt + totalRandomAmount;
    return totalInLamports / LAMPORTS_PER_SOL;
  }, [numLandingWallets, maxAmount]);

  // Add status symbols mapping
  const statusSymbols = {
    pending: "⏳",
    inProgress: "🔄",
    completed: "✅",
    error: "❌"
  };

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  };

  const generateWallets = () => {
    // Initial funding wallet
    const fundingWallet = Keypair.generate();
    const landingWallets = [];
    for (let i = 0; i < numLandingWallets; i++) {
      // 3 proxy wallets per landing wallet
      const proxies = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
      const landing = Keypair.generate();
      landingWallets.push({ proxies, landing });
    }
    setWallets({ fundingWallet, landingWallets });
    setShowWallets(true);
  };

  const startDispersal = async () => {
    if (!wallets) return;
    setDispersing(true);
    setStatus("Connecting to Solana mainnet...");
    const connection = await getConnection();
    const fundingWallet = wallets.fundingWallet;
    const landingWallets = wallets.landingWallets;

    // Initialize all wallet statuses to pending
    const initialStatuses: { [key: string]: string } = {
      funding: "pending"
    };
    landingWallets.forEach((_: any, i: number) => {
      initialStatuses[`landing-${i}`] = "pending";
      initialStatuses[`proxy1-${i}`] = "pending";
      initialStatuses[`proxy2-${i}`] = "pending";
      initialStatuses[`proxy3-${i}`] = "pending";
    });
    setWalletStatuses(initialStatuses);

    // 1. Wait for funding
    setStatus("Waiting for SOL to arrive in the funding wallet...");
    let balance = 0;
    while (balance === 0) {
      balance = await connection.getBalance(fundingWallet.publicKey);
      if (balance === 0) await new Promise(res => setTimeout(res, 3000));
    }
    setWalletStatuses(prev => ({ ...prev, funding: "completed" }));
    setStatus(`Detected funding: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL. Dispersing to proxies...`);

    // 2. Disperse to proxies sequentially
    const totalProxies = landingWallets.length * 3;
    // Calculate total fees needed for the entire chain
    const TOTAL_TRANSACTIONS = 1 + (landingWallets.length * 3); // Initial transfer + 3 transfers per landing wallet
    const totalFees = TOTAL_TRANSACTIONS * FEE_PER_TRANSFER;
    const totalRentExempt = RENT_EXEMPT * (landingWallets.length + 1 + totalProxies); // Rent exempt for funding wallet, landing wallets, and all proxies
    let available = balance - totalFees - totalRentExempt;
    let tx = new Transaction();
    let proxyPubkeys: PublicKey[] = [];
    let idx = 0;

    // Calculate total available balance for distribution
    const totalAvailable = available;

    // First, distribute random amounts to each landing wallet
    const randomAmounts: number[] = [];
    let totalRandomAmount = 0;
    
    // Generate initial random amounts
    for (let i = 0; i < landingWallets.length; i++) {
      const randomAmount = Math.floor(Math.random() * (maxAmount - minAmount) * LAMPORTS_PER_SOL) + Math.floor(minAmount * LAMPORTS_PER_SOL);
      // Add extra SOL for proxy fees and rent exemption
      const amountWithFees = randomAmount + (FEE_PER_TRANSFER * 3) + (RENT_EXEMPT * 3); // Add fees for all 3 proxy transfers and rent for all 3 proxies
      randomAmounts.push(amountWithFees);
      totalRandomAmount += amountWithFees;
    }

    // If total random amount is less than available, distribute remaining SOL proportionally
    if (totalRandomAmount < totalAvailable) {
      const remainingAmount = totalAvailable - totalRandomAmount;
      const totalProportional = randomAmounts.reduce((sum, amount) => sum + amount, 0);
      
      // Distribute remaining amount proportionally based on initial random amounts
      for (let i = 0; i < randomAmounts.length; i++) {
        const proportion = randomAmounts[i] / totalProportional;
        randomAmounts[i] += Math.floor(remainingAmount * proportion);
      }
    }

    // Verify we have enough balance for all transactions
    if (totalRandomAmount > totalAvailable) {
      setStatus(`Error: Insufficient balance. Need ${(totalRandomAmount / LAMPORTS_PER_SOL).toFixed(4)} SOL but only have ${(totalAvailable / LAMPORTS_PER_SOL).toFixed(4)} SOL available after fees.`);
      setDispersing(false);
      return;
    }

    // Distribute funds to landing wallets
    for (let i = 0; i < landingWallets.length; i++) {
      const proxies = landingWallets[i].proxies;
      const amountToSend = randomAmounts[i];
      
      // Send amount to first proxy
      try {
        const tx = new Transaction().add(SystemProgram.transfer({
          fromPubkey: fundingWallet.publicKey,
          toPubkey: proxies[0].publicKey,
          lamports: amountToSend,
        }));
        
        await sendAndConfirmTransaction(connection, tx, [fundingWallet]);
        setStatus(`Sent funds to first proxy for Landing Wallet ${i + 1}. Waiting for confirmation...`);
        
        // Wait for 2 blocks before sending next transaction
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (e) {
        setStatus(`Error sending to first proxy for Landing Wallet ${i + 1}: ${(e as Error).message}`);
        setDispersing(false);
        return;
      }
    }
    
    setStatus("All initial transfers sent. Starting proxy chain transfers...");
    await new Promise(resolve => setTimeout(resolve, 2000)); // Wait before starting proxy chain

    // 3. Chain dispersal: first proxy → second proxy → third proxy → landing wallet
    for (let i = 0; i < landingWallets.length; i++) {
      const lw = landingWallets[i];
      const proxies = lw.proxies;
      const landing = lw.landing;

      // First proxy
      setWalletStatuses(prev => ({ ...prev, [`proxy1-${i}`]: "inProgress" }));
      let proxyBalance = await connection.getBalance(proxies[0].publicKey);
      if (proxyBalance > FEE_PER_TRANSFER + RENT_EXEMPT) {
        const amountToSend = proxyBalance - FEE_PER_TRANSFER - RENT_EXEMPT;
        const tx1 = new Transaction().add(SystemProgram.transfer({
          fromPubkey: proxies[0].publicKey,
          toPubkey: proxies[1].publicKey,
          lamports: amountToSend,
        }));
        try {
          await sendAndConfirmTransaction(connection, tx1, [proxies[0]]);
          setWalletStatuses(prev => ({ ...prev, [`proxy1-${i}`]: "completed" }));
          setStatus(`First proxy for Landing Wallet ${i + 1} sent funds to second proxy. Waiting for confirmation...`);
          await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for 2 blocks
        } catch (e) {
          setWalletStatuses(prev => ({ ...prev, [`proxy1-${i}`]: "error" }));
          setStatus(`Error: First proxy for Landing Wallet ${i + 1}: ${(e as Error).message}`);
          continue;
        }
      } else {
        setWalletStatuses(prev => ({ ...prev, [`proxy1-${i}`]: "error" }));
        setStatus(`Error: First proxy for Landing Wallet ${i + 1} has insufficient balance: ${(proxyBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
        continue;
      }

      // Second proxy
      setWalletStatuses(prev => ({ ...prev, [`proxy2-${i}`]: "inProgress" }));
      proxyBalance = await connection.getBalance(proxies[1].publicKey);
      if (proxyBalance > FEE_PER_TRANSFER + RENT_EXEMPT) {
        const amountToSend = proxyBalance - FEE_PER_TRANSFER - RENT_EXEMPT;
        const tx2 = new Transaction().add(SystemProgram.transfer({
          fromPubkey: proxies[1].publicKey,
          toPubkey: proxies[2].publicKey,
          lamports: amountToSend,
        }));
        try {
          await sendAndConfirmTransaction(connection, tx2, [proxies[1]]);
          setWalletStatuses(prev => ({ ...prev, [`proxy2-${i}`]: "completed" }));
          setStatus(`Second proxy for Landing Wallet ${i + 1} sent funds to third proxy. Waiting for confirmation...`);
          await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for 2 blocks
        } catch (e) {
          setWalletStatuses(prev => ({ ...prev, [`proxy2-${i}`]: "error" }));
          setStatus(`Error: Second proxy for Landing Wallet ${i + 1}: ${(e as Error).message}`);
          continue;
        }
      } else {
        setWalletStatuses(prev => ({ ...prev, [`proxy2-${i}`]: "error" }));
        setStatus(`Error: Second proxy for Landing Wallet ${i + 1} has insufficient balance: ${(proxyBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
        continue;
      }

      // Third proxy
      setWalletStatuses(prev => ({ ...prev, [`proxy3-${i}`]: "inProgress" }));
      proxyBalance = await connection.getBalance(proxies[2].publicKey);
      if (proxyBalance > FEE_PER_TRANSFER + RENT_EXEMPT) {
        const amountToSend = proxyBalance - FEE_PER_TRANSFER - RENT_EXEMPT;
        const tx3 = new Transaction().add(SystemProgram.transfer({
          fromPubkey: proxies[2].publicKey,
          toPubkey: landing.publicKey,
          lamports: amountToSend,
        }));
        try {
          await sendAndConfirmTransaction(connection, tx3, [proxies[2]]);
          setWalletStatuses(prev => ({ ...prev, [`proxy3-${i}`]: "completed", [`landing-${i}`]: "completed" }));
          setStatus(`Third proxy for Landing Wallet ${i + 1} sent funds to landing wallet. Waiting for confirmation...`);
          await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for 2 blocks
        } catch (e) {
          setWalletStatuses(prev => ({ ...prev, [`proxy3-${i}`]: "error", [`landing-${i}`]: "error" }));
          setStatus(`Error: Third proxy for Landing Wallet ${i + 1}: ${(e as Error).message}`);
        }
      } else {
        setWalletStatuses(prev => ({ ...prev, [`proxy3-${i}`]: "error", [`landing-${i}`]: "error" }));
        setStatus(`Error: Third proxy for Landing Wallet ${i + 1} has insufficient balance: ${(proxyBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
      }
    }
    setStatus("Dispersal complete!");
    setDispersing(false);
  };

  const withdrawAll = async () => {
    if (!wallets || !withdrawAddress) return;
    setWithdrawing(true);
    setStatus("Withdrawing SOL from landing wallets and funding wallet...");
    const connection = await getConnection();
    const destination = new PublicKey(withdrawAddress);

    // Withdraw from landing wallets
    for (let i = 0; i < wallets.landingWallets.length; i++) {
      const landing = wallets.landingWallets[i].landing;
      const balance = await connection.getBalance(landing.publicKey);
      if (balance > FEE_PER_TRANSFER + RENT_EXEMPT) {
        const amountToSend = balance - FEE_PER_TRANSFER - RENT_EXEMPT;
        const tx = new Transaction().add(SystemProgram.transfer({
          fromPubkey: landing.publicKey,
          toPubkey: destination,
          lamports: amountToSend,
        }));
        try {
          await sendAndConfirmTransaction(connection, tx, [landing]);
          setStatus(`Withdrawn ${(amountToSend / LAMPORTS_PER_SOL).toFixed(4)} SOL from Landing Wallet ${i + 1}. Waiting for confirmation...`);
          await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for 2 blocks
        } catch (e) {
          setStatus(`Error withdrawing from Landing Wallet ${i + 1}: ${(e as Error).message}`);
          continue;
        }
      } else {
        setStatus(`Skipping Landing Wallet ${i + 1} - insufficient balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
      }
    }

    // Withdraw from funding wallet
    const fundingBalance = await connection.getBalance(wallets.fundingWallet.publicKey);
    if (fundingBalance > FEE_PER_TRANSFER + RENT_EXEMPT) {
      const amountToSend = fundingBalance - FEE_PER_TRANSFER - RENT_EXEMPT;
      const tx = new Transaction().add(SystemProgram.transfer({
        fromPubkey: wallets.fundingWallet.publicKey,
        toPubkey: destination,
        lamports: amountToSend,
      }));
      try {
        await sendAndConfirmTransaction(connection, tx, [wallets.fundingWallet]);
        setStatus(`Withdrawn ${(amountToSend / LAMPORTS_PER_SOL).toFixed(4)} SOL from Funding Wallet. Waiting for confirmation...`);
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for 2 blocks
      } catch (e) {
        setStatus(`Error withdrawing from Funding Wallet: ${(e as Error).message}`);
      }
    } else {
      setStatus(`Skipping Funding Wallet - insufficient balance: ${(fundingBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
    }
    setStatus("Withdrawal complete!");
    setWithdrawing(false);
  };

  const exportPrivateKeys = () => {
    if (!wallets) return;
    const content = wallets.landingWallets.map((lw: any) => {
      return Buffer.from(lw.landing.secretKey).toString('hex');
    }).join('\n');
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'landing_wallet_private_keys.txt';
    a.click();
    URL.revokeObjectURL(url);
  };

  const fetchBalances = async () => {
    if (!wallets) return;
    const connection = await getConnection();
    const newBalances: { [key: string]: number } = {};

    // Fetch funding wallet balance
    const fundingBalance = await connection.getBalance(wallets.fundingWallet.publicKey);
    newBalances['funding'] = fundingBalance / LAMPORTS_PER_SOL;

    // Fetch landing wallet balances
    for (let i = 0; i < wallets.landingWallets.length; i++) {
      const landing = wallets.landingWallets[i].landing;
      const balance = await connection.getBalance(landing.publicKey);
      newBalances[`landing-${i}`] = balance / LAMPORTS_PER_SOL;
    }

    setBalances(newBalances);
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-8 gap-8 bg-gray-50">
      <h1 className="text-4xl font-extrabold mb-4 text-gray-900">Solana Disperser</h1>
      <div className="flex flex-col gap-4 w-full max-w-md">
        <label className="font-semibold text-lg text-gray-800">How many landing wallets?</label>
        <input
          type="number"
          min={1}
          value={numLandingWallets}
          onChange={e => setNumLandingWallets(Number(e.target.value))}
          className="border border-gray-400 rounded px-3 py-2 text-lg text-gray-900 bg-white focus:outline-blue-400"
        />
        <label className="font-semibold text-lg text-gray-800">Minimum SOL per landing wallet:</label>
        <input
          type="number"
          min={0.1}
          step={0.1}
          value={minAmount}
          onChange={e => setMinAmount(Number(e.target.value))}
          className="border border-gray-400 rounded px-3 py-2 text-lg text-gray-900 bg-white focus:outline-blue-400"
        />
        <label className="font-semibold text-lg text-gray-800">Maximum SOL per landing wallet:</label>
        <input
          type="number"
          min={0.1}
          step={0.1}
          value={maxAmount}
          onChange={e => setMaxAmount(Number(e.target.value))}
          className="border border-gray-400 rounded px-3 py-2 text-lg text-gray-900 bg-white focus:outline-blue-400"
        />
        <div className="bg-blue-100 p-4 rounded-lg border border-blue-300">
          <h3 className="font-bold text-blue-800 mb-2">Estimated Total SOL Needed:</h3>
          <p className="text-blue-900">
            <span className="font-mono text-lg">{estimatedTotal.toFixed(4)} SOL</span>
            <br />
            <span className="text-sm">
              (Includes {numLandingWallets} landing wallets × {maxAmount} SOL max each,<br />
              plus fees and rent exemption)
            </span>
          </p>
        </div>
        <button
          onClick={generateWallets}
          className="bg-blue-700 text-white rounded px-4 py-2 font-bold hover:bg-blue-800 transition text-lg shadow"
        >
          Generate Wallets
        </button>
        <button
          onClick={fetchBalances}
          className="bg-green-700 text-white rounded px-4 py-2 font-bold hover:bg-green-800 transition text-lg shadow"
        >
          Refresh Balances
        </button>
      </div>
      {showWallets && wallets && (
        <div className="w-full max-w-2xl mt-8">
          <h2 className="text-2xl font-bold mb-2 text-gray-900">Initial Funding Wallet</h2>
          <div className="mb-4 break-all bg-gray-800 text-green-200 p-3 rounded font-mono text-lg shadow-inner select-all">
            <div className="flex items-center gap-2">
              <span>{statusSymbols[walletStatuses['funding'] as keyof typeof statusSymbols] || "⏳"}</span>
              <div>Public Key: {wallets.fundingWallet.publicKey.toBase58()}</div>
            </div>
            <div>Balance: {balances['funding'] ? balances['funding'].toFixed(4) : '0.0000'} SOL</div>
            <button
              onClick={() => copyToClipboard(wallets.fundingWallet.publicKey.toBase58(), 'funding-public')}
              className="mt-2 bg-yellow-600 text-white rounded px-2 py-1 text-sm font-semibold hover:bg-yellow-700 transition"
            >
              {copied === 'funding-public' ? 'Copied!' : 'Copy Public Key'}
            </button>
            <button
              onClick={() => copyToClipboard(Buffer.from(wallets.fundingWallet.secretKey).toString('hex'), 'funding')}
              className="mt-2 ml-2 bg-yellow-600 text-white rounded px-2 py-1 text-sm font-semibold hover:bg-yellow-700 transition"
            >
              {copied === 'funding' ? 'Copied!' : 'Copy Private Key'}
            </button>
          </div>
          <h2 className="text-2xl font-bold mb-2 text-gray-900">Landing Wallets & Proxies</h2>
          <ol className="list-decimal ml-6">
            {wallets.landingWallets.map((lw: any, i: number) => (
              <li key={i} className="mb-6">
                <div className="mb-1 font-semibold text-lg text-gray-800">Landing Wallet {i + 1}:</div>
                <div className="break-all bg-green-700 text-white p-3 rounded mb-2 font-mono text-base shadow-inner select-all">
                  <div className="flex items-center gap-2">
                    <span>{statusSymbols[walletStatuses[`landing-${i}`] as keyof typeof statusSymbols] || "⏳"}</span>
                    <div>Public Key: {lw.landing.publicKey.toBase58()}</div>
                  </div>
                  <div>Balance: {balances[`landing-${i}`] ? balances[`landing-${i}`].toFixed(4) : '0.0000'} SOL</div>
                  <button
                    onClick={() => copyToClipboard(lw.landing.publicKey.toBase58(), `landing-public-${i}`)}
                    className="mt-2 bg-yellow-600 text-white rounded px-2 py-1 text-sm font-semibold hover:bg-yellow-700 transition"
                  >
                    {copied === `landing-public-${i}` ? 'Copied!' : 'Copy Public Key'}
                  </button>
                  <button
                    onClick={() => copyToClipboard(Buffer.from(lw.landing.secretKey).toString('hex'), `landing-${i}`)}
                    className="mt-2 ml-2 bg-yellow-600 text-white rounded px-2 py-1 text-sm font-semibold hover:bg-yellow-700 transition"
                  >
                    {copied === `landing-${i}` ? 'Copied!' : 'Copy Private Key'}
                  </button>
                </div>
                <div className="ml-4">
                  {lw.proxies.map((proxy: any, j: number) => (
                    <div key={j} className="break-all bg-yellow-400 text-gray-900 p-2 rounded mb-1 font-mono text-sm shadow select-all">
                      <div className="flex items-center gap-2">
                        <span>{statusSymbols[walletStatuses[`proxy${j + 1}-${i}`] as keyof typeof statusSymbols] || "⏳"}</span>
                        <div><span className="font-bold">Proxy {j + 1}:</span> {proxy.publicKey.toBase58()}</div>
                      </div>
                      <button
                        onClick={() => copyToClipboard(proxy.publicKey.toBase58(), `proxy-public-${i}-${j}`)}
                        className="mt-1 bg-yellow-600 text-white rounded px-2 py-1 text-sm font-semibold hover:bg-yellow-700 transition"
                      >
                        {copied === `proxy-public-${i}-${j}` ? 'Copied!' : 'Copy Public Key'}
                      </button>
                      <button
                        onClick={() => copyToClipboard(Buffer.from(proxy.secretKey).toString('hex'), `proxy-${i}-${j}`)}
                        className="mt-1 ml-2 bg-yellow-600 text-white rounded px-2 py-1 text-sm font-semibold hover:bg-yellow-700 transition"
                      >
                        {copied === `proxy-${i}-${j}` ? 'Copied!' : 'Copy Private Key'}
                      </button>
                    </div>
                  ))}
                </div>
              </li>
            ))}
          </ol>
          <div className="mt-6">
            <label className="font-semibold text-lg text-gray-800">Withdraw to Address:</label>
            <input
              type="text"
              value={withdrawAddress}
              onChange={e => setWithdrawAddress(e.target.value)}
              className="border border-gray-400 rounded px-3 py-2 text-lg text-gray-900 bg-white focus:outline-blue-400 w-full"
              placeholder="Enter Solana address"
            />
            <button
              onClick={withdrawAll}
              className="mt-2 bg-red-700 text-white rounded px-4 py-2 font-bold hover:bg-red-800 transition text-lg shadow disabled:opacity-50"
              disabled={withdrawing || !withdrawAddress}
            >
              {withdrawing ? "Withdrawing..." : "Withdraw All"}
            </button>
          </div>
          <button
            onClick={exportPrivateKeys}
            className="mt-4 bg-purple-700 text-white rounded px-4 py-2 font-bold hover:bg-purple-800 transition text-lg shadow"
          >
            Export Private Keys
          </button>
          <button
            onClick={startDispersal}
            className="mt-6 bg-green-700 text-white rounded px-4 py-2 font-bold hover:bg-green-800 transition text-lg shadow disabled:opacity-50"
            disabled={dispersing}
          >
            {dispersing ? "Dispersing..." : "Start Dispersal"}
          </button>
          {status && <div className="mt-4 p-3 bg-blue-700 text-white rounded font-bold text-lg shadow-lg">{status}</div>}
        </div>
      )}
    </div>
  );
}