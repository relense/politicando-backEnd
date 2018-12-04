class Api::V1::CommentsController < ApplicationController
  def create
  end

  def show

  end
  
  private

  def create_comment_params
    params
      .require(:comment)
      .permit(:username, :comment, :article_id, :comment_id)
  end

end