import { IsString, IsNotEmpty, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

export class SendMessageDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty({ message: 'message must not be empty' })
  @MaxLength(4000, { message: 'message exceeds maximum length of 4000 chars' })
  message!: string;
}
