class Api::V1::CommentsController < ApplicationController
  def create
    @comment = Comment.new(create_comment_params)
    if @comment.save
      render json: @comment, status: 200
    end
  end
  
  private

  def create_comment_params
    params
      .require(:comments)
      .permit(:username, :comment, :commentType, :article_id, :comments_id)
  end

end