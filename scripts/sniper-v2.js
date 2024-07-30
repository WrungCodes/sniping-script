require("dotenv").config();
const { ethers } = require("hardhat");
const {
  abi: routerABI,
} = require("@uniswap/v2-periphery/build/IUniswapV2Router02.json");
const {
  abi: factoryABI,
} = require("@uniswap/v2-periphery/build/IUniswapV2Factory.json");
const {
  abi: pairABI,
} = require("@uniswap/v2-periphery/build/IUniswapV2Pair.json");
const {
  FlashbotsBundleProvider,
} = require("@flashbots/ethers-provider-bundle");

const routerAddress = "0xC532a74256D3Db42D0Bf7a0400fEFDbad7694008"; // Uniswap V2 Router on Sepolia
const factoryAddress = "0x7E0987E5b3a30e3f2828572Bb659A548460a3003"; // Uniswap V2 Factory on Sepolia
const wethAddress = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9"; // WETH on Sepolia

async function main() {
  // Get the default signer (first account from Hardhat's accounts)
  const [signer] = await ethers.getSigners();

  // Deploy the Token
  console.log("Token deploying...");
  const MyToken = await ethers.getContractFactory("MyToken");
  const myToken = await MyToken.deploy(ethers.utils.parseEther("1000000"));
  await myToken.deployed();
  console.log("Token deployed to:", myToken.address);

  // Authorize Token to be spent by Uniswap
  const tokenAddress = myToken.address;

  const token = await ethers.getContractAt("MyToken", tokenAddress);

  const tokenAmount = ethers.utils.parseEther("1000");
  const ethAmount = ethers.utils.parseEther("0.02");

  // Approve Token for Router
  console.log(`Approving tokens for the router...`);

  const approveTx = await token.approve(
    routerAddress,
    ethers.constants.MaxUint256
  );
  await approveTx.wait();
  console.log("Tokens approved.");

  // Add Liquidity
  console.log("Adding Liquidity.");

  const router = await ethers.getContractAt(routerABI, routerAddress);
  const liquidityTx = await router.addLiquidityETH(
    tokenAddress,
    tokenAmount,
    0,
    0,
    signer.address,
    Math.floor(Date.now() / 1000) + 60 * 10,
    { value: ethAmount }
  );

  console.log("Liquidity Added Successfully.", liquidityTx.hash);

  async function sendFlashbotsTransaction(transaction) {
    console.log("Signing Transaction.");

    const provider = new ethers.providers.JsonRpcProvider(process.env.NODE_URL);
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

    const signedTransaction = await wallet.signTransaction(transaction);

    console.log("Transaction sending via Flashbots.");

    const flashbotsProvider = await FlashbotsBundleProvider.create(
      provider,
      wallet,
      "https://relay-sepolia.flashbots.net",
      "sepolia"
    );

    const bundleSubmission = await flashbotsProvider.sendPrivateTransaction({ signedTransaction });

    const waitResponse = await bundleSubmission.wait();
    if (waitResponse.error) {
      console.error(
        `Flashbots transaction failed: ${waitResponse.error.message}`
      );
      throw waitResponse.error;
    } else {
      console.log("Transaction sent via Flashbots successfully.", bundleSubmission.transaction);
    }
  }

  async function executeSnipeWithRetry(pairAddress, maxRetries = 3) {
    let retries = 0;
    let gasPrice = ethers.utils.parseUnits("20", "gwei");

    while (retries < maxRetries) {
      try {
        const pair = await ethers.getContractAt(pairABI, pairAddress);
        const token0 = await pair.token0();
        const token1 = await pair.token1();
        const amountIn = ethers.utils.parseEther("0.01"); // Amount of ETH to spend
        const path = [wethAddress, token0 === wethAddress ? token1 : token0];

        console.log("Calculating Slipage...");

        const SLIPPAGE = 10; // 10% slippage tolerance

        const amountsOut = await router.getAmountsOut(amountIn, path);
        const minAmountOut = amountsOut[1].mul(100 - SLIPPAGE).div(100);

        console.log("Populating Transaction...");

        const transaction =
          await router.populateTransaction.swapExactETHForTokens(
            minAmountOut,
            path,
            signer.address,
            Math.floor(Date.now() / 1000) + 60 * 10, // 10 minutes deadline
            {
              value: amountIn,
              gasLimit: 300000,
              gasPrice,
            }
          );

        await sendFlashbotsTransaction(transaction);

        console.log("Snipe successful!");
        console.log("");
        return; // Exit if successful
      } catch (error) {
        console.error(`Attempt ${retries + 1} failed:`, error);
        retries++;
        if (retries < maxRetries) {
          console.log("Retrying with higher gas price...");
          gasPrice = gasPrice.mul(120).div(100); // Increase gas price by 20%
        }
      }
    }
    console.error("Max retries reached. Snipe failed.");
  }

  // Token Sniping
  console.log("Token Sniping Process Started and Listening.");

  const factory = await ethers.getContractAt(factoryABI, factoryAddress);
  const filter = factory.filters.PairCreated(null, null);
  factory.on(filter, async (token0, token1, pairAddress) => {
    console.log("Received Factory PairCreated Event.");
    if (token0 === tokenAddress || token1 === tokenAddress) {
      console.log("Liquidity added! Executing snipe...");
      await executeSnipeWithRetry(pairAddress);
    }
  });

  // Keep the script running
  await new Promise(() => {});
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
