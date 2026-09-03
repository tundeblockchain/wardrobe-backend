import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getUserId } from '../../shared/auth';
import { Errors } from '../../shared/errors';
import { created, errorResponse, parseJsonBody } from '../../shared/http';
import { newUploadId } from '../../shared/ids';
import { createPresignedPutUrl, extensionForContentType } from '../../shared/s3';
import { requireNonEmptyString } from '../../shared/validation';

interface CreateUploadBody {
  contentType?: unknown;
  purpose?: unknown;
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
  const contentType = requireNonEmptyString(body.contentType, 'contentType', 64);
  const purpose = requireNonEmptyString(body.purpose, 'purpose', 64);

  if (!ALLOWED_PURPOSES.has(purpose)) {
    throw Errors.uploadInvalid('purpose must be WARDROBE_ITEM.');
  }

  const extension = extensionForContentType(contentType);
  const objectKey = `users/${userId}/uploads/${newUploadId()}.${extension}`;
  const { uploadUrl, expiresIn } = await createPresignedPutUrl({
    objectKey,
    contentType,
  });

  return {
    uploadUrl,
    objectKey,
    expiresIn,
  };
}
