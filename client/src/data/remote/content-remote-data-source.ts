import { type HttpClient, parseDto } from './http-client';
import { guardedApiCall } from '../../core/error-handling/guards';
import {
  contentIndexDtoFromJson,
  topicDtoFromJson,
  type ContentIndexDto,
  type TopicDto,
} from './dtos/content-dto';

/**
 * ContentRemoteDataSource — talks to the content API and returns DTOs.
 * Mirrors the react guide's `PostRemoteDataSource`. Raw engine errors are
 * upgraded to typed AppExceptions by the fetch pipeline + `guardedApiCall`;
 * shape violations are upgraded by `parseDto` (InvalidResponseException).
 */

export interface ContentRemoteDataSource {
  getContentIndex(): Promise<ContentIndexDto>;
  getTopic(id: string): Promise<TopicDto>;
}

const CONTENT_INDEX_PATH = '/content';
const topicPath = (id: string): string => `/content/topics/${encodeURIComponent(id)}`;

export class HttpContentRemoteDataSource implements ContentRemoteDataSource {
  private readonly http: HttpClient;

  constructor(http: HttpClient) {
    this.http = http;
  }

  getContentIndex(): Promise<ContentIndexDto> {
    return guardedApiCall(async () => {
      const { body, status } = await this.http.getJson(CONTENT_INDEX_PATH);
      return parseDto(body, status, contentIndexDtoFromJson);
    });
  }

  getTopic(id: string): Promise<TopicDto> {
    return guardedApiCall(async () => {
      const { body, status } = await this.http.getJson(topicPath(id));
      return parseDto(body, status, topicDtoFromJson);
    });
  }
}
