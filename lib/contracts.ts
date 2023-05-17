const solc = require("solc");
import { findBestMatch } from "string-similarity";
import { ethers } from "ethers";
import chains from "@/lib/chains.json";
import { ChainData, Contract, DeployResults } from "@/lib/types";
import axios from 'axios'

type ContractsType = Contract[];

let contracts: ContractsType = [];

async function fetchImport(importPath: string, sources: { [x: string]: { content: any; }; }) {
  // Check if the file is already in the sources object
  if (sources[importPath]) {
    return;
  }

  // Fetch the imported file
  const unpkgUrl = `https://unpkg.com/${importPath}`;
  const response = await axios.get(unpkgUrl);
  let importedSource = response.data;

  // Replace import statements in the imported source
  const importRegex = /import\s+['"]([^'"]+)['"];/g;
  let match;
  while ((match = importRegex.exec(importedSource)) !== null) {
    const originalImportPath = match[1];

    // Convert relative path to unpkg URL
    let newImportPath = originalImportPath;
    if (originalImportPath.startsWith(".")) {
      const importUrl = new URL(originalImportPath, unpkgUrl);
      newImportPath = importUrl.href.replace("https://unpkg.com/", "");
    }

    await fetchImport(newImportPath, sources);
    importedSource = importedSource.replace(match[0], `import "${newImportPath}";`);
  }

  // Add the imported file to the sources object
  sources[importPath] = {
    content: importedSource,
  };
}

  export const getContracts = (): ContractsType => {
    return contracts;
  };

  export const createContract = (contract: Contract) => {
    contracts = [...contracts, contract];
  };

  export const deleteContract = (contract: Contract): void => {
    const index = contracts.findIndex((item) => item.address === contract.address);
    if (index !== -1) {
      contracts.splice(index, 1);
    }
  };


  export const deployContract = async (
    name: string,
    chain: string,
    sourceCode: string
  ): Promise<DeployResults> => {
    // get the chain object from the chains.json file. Direct match || partial match
    const findAttempt = chains.find((item) => item.name.toLowerCase() === chain.toLowerCase());
    const chainData: ChainData = findAttempt?.chainId
      ? findAttempt
      : (chains.find((chainItem) => {
        const formattedChain = chainItem.name.toLowerCase().replace(/[-_]/g, "");
        const formattedInput = chain.toLowerCase().replace(/[-_]/g, "");
        return (
          findBestMatch(
            formattedInput,
            chains.map((item) => item?.name?.toLowerCase().replace(/[-_]/g, ""))
          ).bestMatch.target === formattedChain
        );
      }) as ChainData);

    if (!chainData?.chainId) {
      const error = new Error(`Chain ${chain} not found`);
      console.log(error);
    }

    const fileName = (name ? name.replace(/[^a-z0-9]/gi, "_").toLowerCase() : "contract") + ".sol";

    // Prepare the sources object for the Solidity compiler
    const sources = {
      [fileName]: {
        content: sourceCode,
      },
    };

    // Parse the source code to find import statements
    const importRegex = /import\s+['"]([^'"]+)['"];/g;
    let match;
    while ((match = importRegex.exec(sourceCode)) !== null) {
      const importPath = match[1];
      await fetchImport(importPath, sources);
    }


    // Compile the contract
    const input = {
      language: "Solidity",
      sources,
      settings: {
        evmVersion: "shanghai",
        outputSelection: {
          "*": {
            "*": ["*"],
          },
        },
      },
    };
    const output = JSON.parse(solc.compile(JSON.stringify(input)));
    if (output.errors) {
      // Filter out warnings
      const errors = output.errors.filter(
        (error: { severity: string }) => error.severity === "error"
      );
      if (errors.length > 0) {
        const error = new Error(errors[0].formattedMessage);
        console.log(error);
      }
    }
    const contract = output.contracts[fileName];

    // Get the contract ABI and bytecode
    const contractName = Object.keys(contract)[0];
    const abi = contract[contractName].abi;
    const bytecode = contract[contractName].evm.bytecode.object;

    // Prepare network, signer, and contract instance
    const rpcUrl: string = chainData?.rpc?.[0]?.replace(
      "${INFURA_API_KEY}",
      process.env.INFURA_API_KEY || ""
    );

    const provider =
      rpcUrl && chainData.chainId
        ? new ethers.providers.JsonRpcProvider(chainData.rpc[0], chainData.chainId)
        : ethers.getDefaultProvider(chainData.chainId);
    if (!(await provider.getNetwork())?.chainId) {
      const error = new Error(`Provider for chain ${chainData.name} not available`);
      console.log(error);
    }

    const signer = new ethers.Wallet("0x" + process.env.PRIVATE_KEY, provider);
    if (!(await signer.getAddress())) {
      const error = new Error(`Signer for chain ${chainData.name} not available`);
      console.log(error);
    }
    const factory = await new ethers.ContractFactory(abi, bytecode, signer);
    const contractDeployment = await factory.deploy();
    const contractAddress = contractDeployment.address;
    const explorerUrl = `${chainData?.explorers?.[0].url}/address/${contractAddress}`;

    createContract({ name, address: contractAddress, chain, sourceCode });
    const deploymentData = { name, chain: chainData?.name, contractAddress, explorerUrl };
    console.log(`Deployment data: `, deploymentData);

    return deploymentData;
  };
