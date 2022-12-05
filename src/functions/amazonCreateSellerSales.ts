import { APIGatewayProxyHandler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import SellingPartnerAPI from 'amazon-sp-api';
import fetch from 'isomorphic-fetch';
import OAuth from 'oauth-1.0a';
import crypto from 'crypto';

const userAgent = 'SalesReportingApi/1.0 (Language=JavaScript/ES6)';

const credentials = {
  SELLING_PARTNER_APP_CLIENT_ID: process.env.suaveSellingPartnerAppClientId,
  SELLING_PARTNER_APP_CLIENT_SECRET: process.env.suaveSellingPartnerAppClientSecret,
  AWS_ACCESS_KEY_ID: process.env.suaveAwsAccessKeyId,
  AWS_SECRET_ACCESS_KEY: process.env.suaveAwsSecretAccessKey,
  AWS_SELLING_PARTNER_ROLE: process.env.suaveAwsSellingPartnerRole,
};

// production credentials
const accountID = process.env.netsuiteAccountId;
const token = {
  key: process.env.netsuiteAccessToken as string,
  secret: process.env.netsuiteTokenSecret as string,
};
const consumer = {
  key: process.env.netsuiteConsumerKey as string,
  secret: process.env.netsuiteConsumerSecret as string,
};

export const nsAuthenticatedFetch = async (url: string, method: string, body?: any) => {
  const requestData = {
    url,
    method,
  };

  const oauth = new OAuth({
    consumer,
    signature_method: 'HMAC-SHA256',
    hash_function(baseString, key) {
      return crypto.createHmac('sha256', key).update(baseString).digest('base64');
    },
    realm: accountID,
  });

  const authorization = oauth.authorize(requestData, token);
  const header: any = oauth.toHeader(authorization);
  header.Authorization += `, realm="${accountID}"`;
  header['content-type'] = 'application/json';
  header['user-agent'] = userAgent;

  try {
    const response = await fetch(requestData.url, {
      method: requestData.method,
      headers: header,
      body: JSON.stringify(body),
    });
    const content: any = await response.json();
    let data: { [key: string]: any };
    if (content.error) {
      data = { success: false, error: content.error };
    } else {
      data = { success: true, content };
    }
    return data;
  } catch (err: any) {
    console.log(err);
    return { success: false, error: err.message };
  }
};

// const getDates = () => {
//   // amazon report get 2 years
//   // start date should be - 2 years, + 1 month fromm current date
//   const date = new Date();
//   const currentYear = date.getFullYear();
//   const currentMonth = date.getMonth() + 1;
//   // const currentDay = date.getDate() > 9 ? date.getDate() : `0${date.getDate()}`;
//   const startYear = currentYear - 2;
//   let startMonth: string | number = currentMonth + 1;
//   startMonth = startMonth === 13 ? 1 : startMonth;
//   // eslint-disable-next-line prefer-const, operator-linebreak
//   startMonth = startMonth < 10 ? `0${startMonth}` : String(startMonth);
//   const startDate = `${startYear}-${startMonth}-01T00:00:00`;
//   const endDate = `${currentYear}-${currentMonth}-01T00:00:00`;
//   return {
//     start: startDate,
//     end: endDate,
//   };
// };

const getDates = () => {
  // amazon report get 2 years
  const date = new Date();
  const currentYear = date.getFullYear();
  const currentMonth = date.getMonth() + 1;
  const startYear = currentYear - 2;
  // start date should be - 2 years, + 1 month fromm current date
  let startMonth: string | number = currentMonth + 1;
  startMonth = startMonth === 13 ? 1 : startMonth;
  // eslint-disable-next-line prefer-const, operator-linebreak
  startMonth = startMonth < 10 ? `0${startMonth}` : String(startMonth);
  let startDate = `${startYear}-${startMonth}-01T00:00:00`;
  const endDate = `${currentYear}-${currentMonth}-01T00:00:00`;

  if (getMonthDifference(startDate, endDate) > 24) {
    startDate = `${startYear + 1}-${startMonth}-01T00:00:00`;
  }

  return {
    start: startDate,
    end: endDate,
  };
};

const getMonthDifference = (start: string, end: string) => {
  const startDate = new Date(start);
  const endDate = new Date(end);
  return endDate.getMonth() - startDate.getMonth() + 12 * (endDate.getFullYear() - startDate.getFullYear());
};

// create report
const createReport = async (sellingPartner: SellingPartnerAPI) => {
  const dates = getDates();
  console.log('CREATING REPORT');
  console.log('START', dates.start);
  console.log('END', dates.end);
  const res = await sellingPartner.callAPI({
    operation: 'reports.createReport',
    body: {
      reportType: 'GET_SALES_AND_TRAFFIC_REPORT',
      reportOptions: {
        dateGranularity: 'MONTH',
        asinGranularity: 'PARENT',
      },
      dataStartTime: dates.start,
      dataEndTime: dates.end,
      marketplaceIds: ['ATVPDKIKX0DER'],
    },
  });

  console.log('res', res);
  // // report id
  return res.reportId;
};

const getReport = async (sellingPartner: SellingPartnerAPI, reportId: string) => {
  const interval = 3000;
  const maxAttempts = 100;
  let attempts = 0;
  // eslint-disable-next-line consistent-return
  const executePoll = async (resolve: any, reject: any) => {
    console.log('POLLING...');
    const reportResponse = await sellingPartner.callAPI({
      operation: 'reports.getReport',
      path: {
        reportId,
      },
    });

    attempts += 1;

    console.log('REPORT RESPONSE STATUS', reportResponse.processingStatus);

    if (reportResponse.processingStatus === 'DONE') {
      console.log('REPORT DONE PROCESSING, DOWNLOADING...');
      const reportDocument = await sellingPartner.callAPI({
        operation: 'reports.getReportDocument',
        path: {
          // retrieve the reportDocumentId from a "getReport" operation
          // (when processingStatus of report is "DONE")
          reportDocumentId: reportResponse.reportDocumentId,
        },
      });

      const reportContent = await sellingPartner.download(reportDocument);

      return resolve({ status: reportResponse.processingStatus, content: reportContent });
    } else if (reportResponse.processingStatus === 'FATAL') {
      return resolve({ status: reportResponse.processingStatus });
    } else if (reportResponse.processingStatus === 'CANCELLED') {
      return resolve({ status: reportResponse.processingStatus });
    } else if (maxAttempts && attempts === maxAttempts) {
      return reject(new Error('Exceeded max attempts'));
    } else {
      setTimeout(executePoll, interval, resolve, reject);
    }
  };

  try {
    const poll = new Promise(executePoll);
    const report = await poll;
    return report;
  } catch (err: any) {
    console.log('ERR', err.message);
  }
};

export const handler: APIGatewayProxyHandler = async (
  event: APIGatewayProxyEvent,
  context: any,
): Promise<APIGatewayProxyResult> => {
  try {
    const body = event.body ? JSON.parse(event.body) : null;
    const year = body && body?.year ? body.year : new Date().getFullYear();
    // init
    const sellingPartner = new SellingPartnerAPI({
      region: 'na', // The region to use for the SP-API endpoints ("eu", "na" or "fe")
      refresh_token: process.env.suaveAwsRefreshToken, // The refresh token of your app user
      options: {
        auto_request_tokens: true,
        debug_log: true,
        user_agent: userAgent,
      },
      credentials: credentials,
    });

    const reportId = await createReport(sellingPartner);

    const report = (await getReport(sellingPartner, reportId)) as {
      status: 'DONE' | 'CANCELLED' | 'FATAL';
      content?: string;
    };
    // do something with report
    const restletUrl = process.env.netsuiteSaveAmazonJsonUrl as string;
    const method = 'POST';
    const res = await nsAuthenticatedFetch(restletUrl, method, {
      status: report.status,
      content: report?.content ? report.content : null,
      fileName: 'amazon_sales_traffic_report',
      fileType: 'JSON',
    });
    if (report.status !== 'CANCELLED' && report.status !== 'FATAL') {
      console.log(`Report (${reportId}) has been generated and saved in NetSuite...`, res);

      return {
        statusCode: 200,
        body: `Report (${reportId}) has been generated and saved in NetSuite...`,
      };
    } else {
      console.log('REPORT FAILED');
      return {
        statusCode: 200,
        body: 'FAILED TO GET REPORT',
      };
    }
    // if (report.status !== 'CANCELLED' && report.status !== 'FATAL') {
    //   // do something with report
    //   const restletUrl = process.env.netsuiteSaveAmazonJsonUrl as string;
    //   const method = 'POST';
    //   const res = await nsAuthenticatedFetch(restletUrl, method, {
    //     status: report.status,
    //     content: report?.content ? report.content : null,
    //     fileName: 'amazon_sales_traffic_report',
    //     fileType: 'JSON',
    //   });

    //   console.log(`Report (${reportId}) has been generated and saved in NetSuite...`, res);

    //   return {
    //     statusCode: 200,
    //     body: `Report (${reportId}) has been generated and saved in NetSuite...`,
    //   };
    // } else {
    //   return {
    //     statusCode: 200,
    //     body: 'FAILED TO GET REPORT',
    //   };
    // }
  } catch (err: any) {
    console.log('ERROR', err.message);
    return {
      statusCode: 500,
      body: 'An error occured',
    };
  }
};
