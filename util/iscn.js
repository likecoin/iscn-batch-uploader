// eslint-disable-next-line import/no-extraneous-dependencies
const { Registry, DirectSecp256k1HdWallet } = require('@cosmjs/proto-signing');
const { MsgCreateIscnRecord, MsgUpdateIscnRecord } = require('@likecoin/iscn-message-types/dist/iscn/tx');
const { TxRaw } = require('cosmjs-types/cosmos/tx/v1beta1/tx');
const {
  defaultRegistryTypes,
  assertIsBroadcastTxSuccess,
  SigningStargateClient,
} = require('@cosmjs/stargate');
const jsonStringify = require('fast-json-stable-stringify');
const BigNumber = require('bignumber.js');

const { ISCN_RPC_URL, COSMOS_MNEMONIC } = require('../config/config');
const { queryFeePerByte } = require('./iscnQuery');

const ISCN_REGISTRY_NAME = 'likecoin-chain';
const GAS_ESTIMATOR_BUFFER = 50000;
const GAS_ESTIMATOR_SLOP = 3.58;
const GAS_ESTIMATOR_INTERCEPT = 99443.87;
const DEFAULT_GAS_PRICE_NUMBER = 10;

const registry = new Registry([
  ...defaultRegistryTypes,
  ['/likechain.iscn.MsgCreateIscnRecord', MsgCreateIscnRecord],
  ['/likechain.iscn.MsgUpdateIscnRecord', MsgUpdateIscnRecord],
]);

let signingWallet;
let signingAccounts;
let signingClient;

async function getWallet() {
  if (!signingWallet) {
    signingWallet = await DirectSecp256k1HdWallet.fromMnemonic(COSMOS_MNEMONIC);
    [signingAccounts] = await signingWallet.getAccounts();
    console.log(signingAccounts.address);
  }
  return { wallet: signingWallet, account: signingAccounts };
}

function parseISCNTxInfoFromTxSuccess(tx) {
  const { transactionHash } = tx;
  let iscnId;
  if (tx.rawLog) {
    const [log] = JSON.parse(tx.rawLog);
    if (log) {
      const ev = log.events.find((e) => e.type === 'iscn_record');
      if (ev) iscnId = ev.attributes[0].value;
    }
  }
  return {
    txHash: transactionHash,
    iscnId,
  };
}

function estimateISCNTxGas(dataObj) {
  const bytes = Buffer.from(jsonStringify(dataObj), 'utf-8');
  const gas = new BigNumber(bytes.length)
    .multipliedBy(GAS_ESTIMATOR_SLOP)
    .plus(GAS_ESTIMATOR_INTERCEPT)
    .plus(GAS_ESTIMATOR_BUFFER);
  const gasFee = gas.multipliedBy(DEFAULT_GAS_PRICE_NUMBER);
  return {
    amount: [{ amount: gasFee.toFixed(0, 0), denom: 'nanolike' }],
    gas: gas.toFixed(0, 0),
  };
}

function formatISCNPayload(payload, version = 1) {
  const {
    hash,
    hashes,
    title,
    description,
    url,
    author,
    type,
    ...fields
  } = payload;

  const contentFingerprints = hashes || [hash];
  const stakeholders = [];
  if (author) {
    stakeholders.push(Buffer.from(JSON.stringify({
      entity: {
        id: author,
        name: author,
      },
      rewardProportion: 1,
      contributionType: 'http://schema.org/author',
    }), 'utf8'));
  }
  const contentMetadata = {
    ...fields,
    '@context': 'http://schema.org/',
    '@type': type || 'CreativeWork',
    title,
    author,
    description,
    version,
    url,
  };
  return {
    recordNotes: '',
    contentFingerprints,
    stakeholders,
    contentMetadata: Buffer.from(JSON.stringify(contentMetadata), 'utf8'),
  };
}

async function estimateISCNTxFee(tx, {
  version = 1,
} = {}) {
  const record = formatISCNPayload(tx);
  const feePerByte = await queryFeePerByte();
  const {
    recordNotes,
    contentFingerprints,
    stakeholders,
    contentMetadata,
  } = record;
  const now = new Date();
  const obj = {
    '@context': {
      '@vocab': 'http://iscn.io/',
      recordParentIPLD: {
        '@container': '@index',
      },
      stakeholders: {
        '@context': {
          '@vocab': 'http://schema.org/',
          entity: 'http://iscn.io/entity',
          rewardProportion: 'http://iscn.io/rewardProportion',
          contributionType: 'http://iscn.io/contributionType',
          footprint: 'http://iscn.io/footprint',
        },
      },
      contentMetadata: {
        '@context': null,
      },
    },
    '@type': 'Record',
    '@id': `iscn://${ISCN_REGISTRY_NAME}/btC7CJvMm4WLj9Tau9LAPTfGK7sfymTJW7ORcFdruCU/1`,
    recordTimestamp: now.toISOString(),
    recordVersion: version,
    recordNotes,
    contentFingerprints,
    recordParentIPLD: {},
  };
  if (version > 1) {
    obj.recordParentIPLD = {
      '/': 'bahuaierav3bfvm4ytx7gvn4yqeu4piiocuvtvdpyyb5f6moxniwemae4tjyq',
    };
  }
  const byteSize = Buffer.from(JSON.stringify(obj), 'utf-8').length
    + stakeholders.reduce((acc, s) => acc + s.length, 0)
    + contentMetadata.length;
  const feeAmount = byteSize * feePerByte;
  return feeAmount;
}

async function getSigningClient(wallet) {
  if (!signingClient) {
    signingClient = await SigningStargateClient.connectWithSigner(
      ISCN_RPC_URL,
      wallet,
      { registry },
    );
  }
  return signingClient;
}

async function signISCNTx(inputPayload, explicitSignerData = null) {
  const { wallet, account } = await getWallet();
  const { iscnId, ...payload } = inputPayload;
  const isUpdate = !!iscnId;
  const record = formatISCNPayload(payload);
  const client = await getSigningClient(wallet);

  const value = {
    from: account.address,
    record,
  };
  if (isUpdate) value.iscnId = iscnId;
  const message = {
    typeUrl: isUpdate ? '/likechain.iscn.MsgUpdateIscnRecord' : '/likechain.iscn.MsgCreateIscnRecord',
    value,
  };
  const fee = await estimateISCNTxGas(message);
  const txRaw = await client.sign(account.address, [message], fee, '', explicitSignerData);
  const txBytes = TxRaw.encode(txRaw).finish();
  const response = await client.broadcastTx(txBytes);
  assertIsBroadcastTxSuccess(response);
  return parseISCNTxInfoFromTxSuccess(response);
}

async function getSequence() {
  const { wallet, account: { address } } = await getWallet();
  const client = await getSigningClient(wallet);
  const { sequence } = await client.getSequence(address);
  return sequence;
}

async function getSignerData() {
  const { wallet, account: { address } } = await getWallet();
  const client = await getSigningClient(wallet);
  const { accountNumber, sequence } = await client.getSequence(address);
  const chainId = await client.getChainId();
  return { accountNumber, sequence, chainId };
}

module.exports = {
  getWallet,
  estimateISCNTxGas,
  estimateISCNTxFee,
  signISCNTx,
  getSequence,
  getSignerData,
};
