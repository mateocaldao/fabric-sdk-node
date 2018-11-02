/**
 * Copyright 2018 IBM All Rights Reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;
chai.use(require('chai-as-promised'));

const Channel = require('fabric-client/lib/Channel');
const Contract = require('fabric-network/lib/contract');
const Network = require('fabric-network/lib/network');
const QueryHandler = require('fabric-network/lib/api/queryhandler');
const Transaction = require('fabric-network/lib/transaction');
const TransactionEventHandler = require('fabric-network/lib/impl/event/transactioneventhandler');
const TransactionID = require('fabric-client/lib/TransactionID');

describe('Transaction', () => {
	let stubContract;

	beforeEach(() => {
		stubContract = sinon.createStubInstance(Contract);

		const transactionId = sinon.createStubInstance(TransactionID);
		transactionId.getTransactionID.returns('TRANSACTION_ID');
		stubContract.createTransactionID.returns(transactionId);

		const network = sinon.createStubInstance(Network);
		stubContract.getNetwork.returns(network);

		const channel = sinon.createStubInstance(Channel);
		network.getChannel.returns(channel);

		stubContract.getChaincodeId.returns('chaincode-id');
		stubContract.getEventHandlerOptions.returns({commitTimeout: 418});
	});

	afterEach(() => {
		sinon.restore();
	});

	describe('#getName', () => {
		it('return the name', () => {
			const name = 'TRANSACTION_NAME';
			const transaction = new Transaction(stubContract, name);
			const result = transaction.getName();
			expect(result).to.equal(name);
		});
	});

	describe('#getTransactionID', () => {
		it('has a default transaction ID', () => {
			const transaction = new Transaction(stubContract, 'name');
			const result = transaction.getTransactionID();
			expect(result).to.be.an.instanceOf(TransactionID);
		});
	});

	describe('#submit', () => {
		const transactionName = 'TRANSACTION_NAME';
		const expectedResult = Buffer.from('42');

		const fakeProposal = {proposal: 'I do'};
		const fakeHeader = {header: 'gooooal'};
		const validProposalResponse = {
			response: {
				status: 200,
				payload: expectedResult
			}
		};
		const emptyProposalResponse = {
			response: {
				status: 200
			}
		};
		const errorProposalResponse = Object.assign(new Error(), {response: {status: 500, payload: 'error'}});

		const validProposalResponses = [[validProposalResponse], fakeProposal, fakeHeader];
		const emptyProposalResponses = [[emptyProposalResponse], fakeProposal, fakeHeader];
		const noProposalResponses = [[], fakeProposal, fakeHeader];
		const errorProposalResponses = [[errorProposalResponse], fakeProposal, fakeHeader];
		const mixedProposalResponses = [[validProposalResponse, errorProposalResponse], fakeProposal, fakeHeader];

		let transaction;
		let expectedProposal;
		let channel;

		beforeEach(() => {
			transaction = new Transaction(stubContract, transactionName);

			expectedProposal = {
				fcn: transactionName,
				txId: transaction.getTransactionID(),
				chaincodeId: stubContract.getChaincodeId(),
				args: []
			};

			channel = stubContract.getNetwork().getChannel();
			channel.sendTransactionProposal.resolves(validProposalResponses);
			channel.sendTransaction.resolves({status: 'SUCCESS'});
		});

		it('rejects for non-string arguments', () => {
			const promise = transaction.submit('arg1', 3.142, null);
			return expect(promise).to.be.rejectedWith('"arg1", 3.142, null');
		});

		it('sends proposal with no arguments', async () => {
			await transaction.submit();
			sinon.assert.calledWith(channel.sendTransactionProposal, sinon.match(expectedProposal));
		});

		it('sends proposal with arguments', async () => {
			const args = ['one', 'two', 'three'];
			expectedProposal.args = args;
			await transaction.submit(...args);
			sinon.assert.calledWith(channel.sendTransactionProposal, sinon.match(expectedProposal));
		});

		it('returns null for empty proposal response payload', async () => {
			channel.sendTransactionProposal.resolves(emptyProposalResponses);
			const result = await transaction.submit();
			expect(result).to.be.null;
		});

		it('returns proposal response payload', async () => {
			const result = await transaction.submit();
			expect(result).to.equal(expectedResult);
		});

		it('throws if no peer responses are returned', () => {
			channel.sendTransactionProposal.resolves(noProposalResponses);
			const promise = transaction.submit();
			return expect(promise).to.be.rejectedWith('No results were returned from the request');
		});

		it('throws if proposal responses are all errors', () => {
			channel.sendTransactionProposal.resolves(errorProposalResponses);
			const promise = transaction.submit();
			return expect(promise).to.be.rejectedWith('No valid responses from any peers');
		});

		it('succeeds if some proposal responses are valid', () => {
			channel.sendTransactionProposal.resolves(mixedProposalResponses);
			const promise = transaction.submit();
			return expect(promise).to.be.fulfilled;
		});

		it('throws if the orderer returns an unsuccessful response', () => {
			const status = 'FAILURE';
			channel.sendTransaction.resolves({status});
			const promise = transaction.submit();
			return expect(promise).to.be.rejectedWith(status);
		});

		it('sends only valid proposal responses to orderer', async () => {
			channel.sendTransactionProposal.resolves(mixedProposalResponses);
			await transaction.submit();
			const expected = {
				proposalResponses: [validProposalResponse],
				proposal: fakeProposal
			};
			sinon.assert.calledWith(channel.sendTransaction, sinon.match(expected));
		});

		it('uses a supplied event handler strategy', async () => {
			const stubEventHandler = sinon.createStubInstance(TransactionEventHandler);
			const txId = transaction.getTransactionID().getTransactionID();
			const network = stubContract.getNetwork();
			const options = stubContract.getEventHandlerOptions();
			const stubEventHandlerFactoryFn = sinon.stub();
			stubEventHandlerFactoryFn.withArgs(txId, network, options).returns(stubEventHandler);

			transaction.setEventHandlerStrategy(stubEventHandlerFactoryFn);
			await transaction.submit();

			sinon.assert.called(stubEventHandler.startListening);
			sinon.assert.called(stubEventHandler.waitForEvents);
		});

		it('sends a proposal with transient data', async () => {
			const transientMap = {key1: 'value1', key2: 'value2'};
			expectedProposal.transientMap = transientMap;

			transaction.setTransient(transientMap);
			await transaction.submit();

			sinon.assert.calledWith(channel.sendTransactionProposal, sinon.match(expectedProposal));
		});
	});

	describe('#evaluate', () => {
		const transactionName = 'TRANSACTION_NAME';
		const expectedResult = Buffer.from('42');

		let stubQueryHandler;
		let transaction;

		beforeEach(() => {
			stubQueryHandler = sinon.createStubInstance(QueryHandler);
			stubQueryHandler.queryChaincode.resolves(expectedResult);
			stubContract.getQueryHandler.returns(stubQueryHandler);

			transaction = new Transaction(stubContract, transactionName);
		});

		it('returns the result from the query handler', async () => {
			const result = await transaction.evaluate();
			expect(result).to.equal(expectedResult);
		});

		it('passes required parameters to query handler for no-args invocation', async () => {
			await transaction.evaluate();
			sinon.assert.calledWith(stubQueryHandler.queryChaincode,
				stubContract.getChaincodeId(),
				transaction.getTransactionID(),
				transactionName,
				[]
			);
		});

		it('passes required parameters to query handler for with-args invocation', async () => {
			const args = ['a', 'b', 'c'];

			await transaction.evaluate(...args);

			sinon.assert.calledWith(stubQueryHandler.queryChaincode,
				stubContract.getChaincodeId(),
				transaction.getTransactionID(),
				transactionName,
				args
			);
		});

		it('passes transient data to query handler', async () => {
			const transientMap = {key1: 'value1', key2: 'value2'};
			transaction.setTransient(transientMap);

			await transaction.evaluate();

			sinon.assert.calledWith(stubQueryHandler.queryChaincode,
				sinon.match.any,
				sinon.match.any,
				sinon.match.any,
				sinon.match.any,
				transientMap
			);
		});

		it('rejects for non-string arguments', () => {
			const promise = transaction.evaluate('arg1', 3.142, null);
			return expect(promise).to.be.rejectedWith('"arg1", 3.142, null');
		});
	});
});