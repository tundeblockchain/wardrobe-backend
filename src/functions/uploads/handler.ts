import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getUserId } from '../../shared/auth';
import { Errors } from '../../shared/errors';
import { created, errorResponse, parseJsonBody } from '../../shared/http';
import { newUploadId } from '../../shared/ids';
import {
  assertUploadContentLength,
  createPresignedPutUrl,
  extensionForContentType,
  normalizeContentType,
} from '../../shared/s3';
import { optionalInteger, requireNonEmptyString } from '../../shared/validation';

interface CreateUploadBody {
  contentType?: unknown;
  purpose?: unknown;
  contentLength?: unknown;
  userId?: unknown;
}

const ALLOWED_PURPOSES = new Set(['WARDROBE_ITEM']);

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  try {
    const userId = getUserId(event);
    return created(await createUploadUrl(userId, parseJsonBody(event)));
  } catch (error) {
    return errorResponse(error);
  }
}

async function createUploadUrl(userId: string, body: CreateUploadBody) {
  const contentType = normalizeContentType(
    requireNonEmptyString(body.contentType, 'contentType', 64),
  );
  const purpose = requireNonEmptyString(body.purpose, 'purpose', 64);

  if (!ALLOWED_PURPOSES.has(purpose)) {
    throw Errors.uploadInvalid('purpose must be WARDROBE_ITEM.');
  }

  const declaredLength = optionalInteger(body.contentLength, 'contentLength');
  const contentLength =
    declaredLength === undefined
      ? undefined
      : assertUploadContentLength(declaredLength);

  const extension = extensionForContentType(contentType);
  const objectKey = `users/${userId}/uploads/${newUploadId()}.${extension}`;
  const { uploadUrl, expiresIn } = await createPresignedPutUrl({
    objectKey,
    contentType,
    contentLength,
  });

  return {
    uploadUrl,
    objectKey,
    expiresIn,
  };
}
